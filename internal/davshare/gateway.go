package davshare

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/net/webdav"

	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/store"
)

// Prefix is where shares are mounted on the manager listener.
const Prefix = "/dav/"

// Failed-auth throttling: an IP with maxAuthFailures failed Basic auth
// attempts inside authFailWindow is refused with 429 until the window
// that started with its first failure ends. Keyed on the TCP peer
// address (not X-Forwarded-For, which a client could rotate freely),
// and for IPv6 on its /64, which a single host can rotate through.
const (
	maxAuthFailures   = 10
	authFailWindow    = 5 * time.Minute
	maxLimiterEntries = 10000
)

// Successful credentials are remembered for authCacheTTL so a client
// that sends Basic auth on every request (all of them do) does not pay
// a bcrypt comparison per PROPFIND. The cache key includes the stored
// hash, so rotating the password invalidates it immediately.
const (
	authCacheTTL        = 5 * time.Minute
	maxAuthCacheEntries = 1024
)

// ShareStore is the slice of *store.Store the gateway reads.
type ShareStore interface {
	GetShareByName(name string) (store.Share, error)
}

// Gateway serves every enabled share under /dav/{name}/. It is mounted
// outside the manager's /api token gate and enforces its own per-share
// HTTP Basic auth before any request reaches the WebDAV handler.
type Gateway struct {
	store   ShareStore
	client  *AgentClient
	logger  *slog.Logger
	tempDir string

	mu     sync.Mutex
	shares map[int64]*shareHandler

	auth    authCache
	limiter failLimiter
}

type shareHandler struct {
	key string
	dav *webdav.Handler
}

// NewGateway builds the /dav/ handler. tempDir holds upload buffers
// ("" means os.TempDir()).
func NewGateway(st ShareStore, client *AgentClient, logger *slog.Logger, tempDir string) *Gateway {
	if logger == nil {
		logger = slog.Default()
	}
	return &Gateway{
		store:   st,
		client:  client,
		logger:  logger,
		tempDir: tempDir,
		shares:  map[int64]*shareHandler{},
		auth:    authCache{m: newTTLMap[[32]byte, struct{}](maxAuthCacheEntries)},
		limiter: failLimiter{m: newTTLMap[string, *failRecord](maxLimiterEntries)},
	}
}

// Client returns the agent client the gateway uses, so the share API
// can validate a remote path with the same connection settings.
func (g *Gateway) Client() *AgentClient { return g.client }

// Forget drops the cached handler (lock table, stat cache) for a share
// that was deleted.
func (g *Gateway) Forget(id int64) {
	g.mu.Lock()
	delete(g.shares, id)
	g.mu.Unlock()
}

// mutatingMethods are refused on a read-only share before the WebDAV
// handler runs. LOCK is included so clients (Finder in particular)
// detect the share as read-only and mount it that way.
var mutatingMethods = map[string]bool{
	http.MethodPut:    true,
	http.MethodDelete: true,
	"MKCOL":           true,
	"COPY":            true,
	"MOVE":            true,
	"PROPPATCH":       true,
	"LOCK":            true,
	"UNLOCK":          true,
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest, ok := strings.CutPrefix(r.URL.Path, Prefix)
	if !ok {
		http.NotFound(w, r)
		return
	}
	name, _, _ := strings.Cut(rest, "/")

	// Share content is served from the manager's own origin, and a
	// remote agent's files are not trusted: an HTML or SVG file opened
	// in a browser must not run script with access to the manager UI's
	// session. The CSP sandbox gives the document an opaque origin.
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	ip := peerIP(r)
	if wait := g.limiter.blocked(limiterKey(ip), time.Now()); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		http.Error(w, "too many failed authentication attempts", http.StatusTooManyRequests)
		return
	}

	if !store.IsShareName(name) {
		http.NotFound(w, r)
		return
	}
	sh, err := g.store.GetShareByName(name)
	if errors.Is(err, store.ErrShareNotFound) || (err == nil && !sh.Enabled) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		g.logger.Error("file share lookup failed", slog.String("share", name), slog.String("err", err.Error()))
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	user, pass, hasAuth := r.BasicAuth()
	if !hasAuth {
		challenge(w, sh.Name)
		return
	}
	if !g.checkCredentials(sh, user, pass) {
		g.limiter.fail(limiterKey(ip), time.Now())
		g.logger.Warn("file share authentication failed",
			slog.String("share", sh.Name), slog.String("remote", ip), slog.String("user", user))
		challenge(w, sh.Name)
		return
	}

	if sh.ReadOnly && mutatingMethods[r.Method] {
		http.Error(w, "share is read-only", http.StatusForbidden)
		return
	}

	switch r.Method {
	case "PROPFIND":
		// Depth: infinity would walk the whole remote tree over the
		// mesh. Refuse it explicitly (RFC 4918 propfind-finite-depth)
		// and read a missing header as 1 rather than infinity.
		switch d := r.Header.Get("Depth"); {
		case d == "":
			r.Header.Set("Depth", "1")
		case strings.EqualFold(d, "infinity"):
			w.Header().Set("Content-Type", "application/xml; charset=utf-8")
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`))
			return
		}
	case http.MethodGet, http.MethodHead:
		// Pre-set the type so http.ServeContent does not sniff the
		// first 512 bytes, which would cost an extra ranged download
		// for an extensionless file served from a non-zero offset.
		w.Header().Set("Content-Type", contentTypeFor(path.Base(r.URL.Path)))
	}

	g.handlerFor(sh).dav.ServeHTTP(w, r)
}

// handlerFor returns the WebDAV handler for sh, rebuilding it when the
// agent, path, or read-only flag changed since it was built. The
// handler (and with it the lock table and stat cache) otherwise lives
// for the life of the process.
func (g *Gateway) handlerFor(sh store.Share) *shareHandler {
	key := sh.Name + "\x00" + sh.AgentID + "\x00" + sh.RemotePath + "\x00" + strconv.FormatBool(sh.ReadOnly)
	g.mu.Lock()
	defer g.mu.Unlock()
	if h, ok := g.shares[sh.ID]; ok && h.key == key {
		return h
	}
	name := sh.Name
	h := &shareHandler{
		key: key,
		dav: &webdav.Handler{
			Prefix:     Prefix + sh.Name,
			FileSystem: NewFS(g.client, sh.AgentID, sh.RemotePath, sh.ReadOnly, g.tempDir),
			LockSystem: newLockSystem(),
			Logger: func(r *http.Request, err error) {
				if err != nil {
					g.logger.Debug("webdav request failed", slog.String("share", name),
						slog.String("method", r.Method), slog.String("path", r.URL.Path),
						slog.String("err", err.Error()))
				}
			},
		},
	}
	g.shares[sh.ID] = h
	return h
}

func challenge(w http.ResponseWriter, name string) {
	w.Header().Set("WWW-Authenticate", `Basic realm="Muti Metroo share `+name+`", charset="UTF-8"`)
	http.Error(w, "authentication required", http.StatusUnauthorized)
}

// checkCredentials compares user in constant time and pass against the
// bcrypt hash, consulting the success cache first.
func (g *Gateway) checkCredentials(sh store.Share, user, pass string) bool {
	wantUser := sha256.Sum256([]byte(sh.Username))
	gotUser := sha256.Sum256([]byte(user))
	userOK := subtle.ConstantTimeCompare(wantUser[:], gotUser[:]) == 1

	key := credentialKey(sh, user, pass)
	now := time.Now()
	if g.auth.ok(key, now) {
		return userOK
	}
	// Always run bcrypt, even for a wrong user name, so the response
	// time does not reveal whether the user name matched.
	passOK := bcrypt.CompareHashAndPassword([]byte(sh.PasswordHash), []byte(pass)) == nil
	if userOK && passOK {
		g.auth.add(key, now)
		return true
	}
	return false
}

func credentialKey(sh store.Share, user, pass string) [32]byte {
	h := sha256.New()
	var id [8]byte
	binary.BigEndian.PutUint64(id[:], uint64(sh.ID))
	for _, part := range [][]byte{id[:], []byte(sh.PasswordHash), []byte(user), []byte(pass)} {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(part)))
		h.Write(n[:])
		h.Write(part)
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// peerIP is the TCP peer host, ignoring forwarding headers on purpose.
func peerIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// limiterKey is the failed-auth throttling key for a peer address: the
// address itself for IPv4, the /64 prefix for IPv6.
func limiterKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil || a.Unmap().Is4() {
		return ip
	}
	p, err := a.Prefix(64)
	if err != nil {
		return ip
	}
	return p.String()
}

type authCache struct {
	mu sync.Mutex
	m  ttlMap[[32]byte, struct{}]
}

func (c *authCache) ok(key [32]byte, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, _, found := c.m.get(key, now)
	return found
}

func (c *authCache) add(key [32]byte, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m.put(key, struct{}{}, now.Add(authCacheTTL), now)
}

// failLimiter counts failed logins per key inside a window that starts
// with the first failure.
type failLimiter struct {
	mu sync.Mutex
	m  ttlMap[string, *failRecord]
}

type failRecord struct {
	count int
}

// blocked returns how long key must still wait, or 0.
func (l *failLimiter) blocked(key string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec, end, ok := l.m.get(key, now)
	if ok && rec.count >= maxAuthFailures {
		return end.Sub(now)
	}
	return 0
}

func (l *failLimiter) fail(key string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec, _, ok := l.m.get(key, now)
	if !ok {
		rec = &failRecord{}
		l.m.put(key, rec, now.Add(authFailWindow), now)
	}
	rec.count++
}

// HashPassword returns the bcrypt hash stored for a share password.
func HashPassword(pass string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
	return string(h), err
}

// passwordAlphabet avoids look-alike characters (0/O, 1/l/I) so a
// password read off the screen can be typed into a mount dialog.
const passwordAlphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// GeneratePassword returns a random 20-character password (about 117
// bits of entropy).
func GeneratePassword() (string, error) {
	out := make([]byte, 20)
	max := big.NewInt(int64(len(passwordAlphabet)))
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = passwordAlphabet[n.Int64()]
	}
	return string(out), nil
}
