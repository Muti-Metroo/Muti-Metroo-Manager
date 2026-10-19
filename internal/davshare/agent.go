// Package davshare serves agent folders over WebDAV. Each share maps
// /dav/{name}/ on the manager's listener to one folder on one agent and
// translates WebDAV operations into the agent's signed file-transfer
// API (file/browse, file/download, file/upload), which the connected
// agent relays through the mesh to the target agent.
package davshare

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Per-operation deadlines on top of the WebDAV request context. Browse
// calls are small JSON round trips; a download chunk is bounded by
// maxChunk; an upload carries a whole file and gets the same 30 minute
// budget as the /api/proxy file-transfer paths.
const (
	browseTimeout   = 30 * time.Second
	downloadTimeout = 2 * time.Minute
	uploadTimeout   = 30 * time.Minute
)

// maxListPage is the largest page the agent's list action returns.
const maxListPage = 5000

// maxListEntries caps a single directory listing so a huge directory
// cannot grow manager memory without bound.
const maxListEntries = 100000

// AgentClient calls the connected agent's file-transfer HTTP API with
// the same base URL, bearer token, and TLS settings as the /api/proxy
// reverse proxy.
type AgentClient struct {
	baseURL string
	token   string
	client  *http.Client
}

// NewAgentClient builds a client for agentURL. Timeouts come from the
// per-call contexts, not from http.Client.Timeout, so a long upload is
// not cut off by a short global deadline.
func NewAgentClient(agentURL, token string, tlsCfg *tls.Config) *AgentClient {
	return &AgentClient{
		baseURL: strings.TrimRight(agentURL, "/"),
		token:   token,
		client: &http.Client{
			Transport: &http.Transport{
				TLSClientConfig:     tlsCfg,
				MaxIdleConnsPerHost: 16,
			},
		},
	}
}

// FileEntry mirrors the agent's file/browse entry.
type FileEntry struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime string `json:"mod_time"`
	IsDir   bool   `json:"is_dir"`
}

type browseRequest struct {
	Action    string `json:"action"`
	Path      string `json:"path,omitempty"`
	NewPath   string `json:"new_path,omitempty"`
	Offset    int    `json:"offset,omitempty"`
	Limit     int    `json:"limit,omitempty"`
	Recursive bool   `json:"recursive,omitempty"`
}

type browseResponse struct {
	Entries   []FileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
	Entry     *FileEntry  `json:"entry"`
	Error     string      `json:"error"`
	ErrorCode string      `json:"error_code"`
}

// AgentError is a failure reported by the agent (or the relay in
// front of it). Code is the agent's stable error_code / code when it
// sent one.
type AgentError struct {
	Op     string
	Path   string
	Status int
	Code   string
	Msg    string
}

func (e *AgentError) Error() string {
	msg := e.Msg
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	if e.Code != "" {
		return fmt.Sprintf("agent %s %s: %s (%s)", e.Op, e.Path, msg, e.Code)
	}
	return fmt.Sprintf("agent %s %s: %s", e.Op, e.Path, msg)
}

// kind maps the error to the os sentinel the WebDAV layer understands.
// The stable error_code wins; the message heuristics cover agents that
// predate error_code and download/upload errors relayed as plain text.
func (e *AgentError) kind() error {
	switch e.Code {
	case "not_found":
		return os.ErrNotExist
	case "already_exists":
		return os.ErrExist
	case "not_allowed", "auth_required", "invalid_credentials":
		return os.ErrPermission
	case "not_empty":
		return errNotEmpty
	}
	if e.Status == http.StatusNotFound {
		// The agent answers its file endpoints with 400/502; a 404
		// means the endpoint itself is missing, not the file.
		return nil
	}
	msg := strings.ToLower(e.Msg)
	switch {
	case strings.Contains(msg, "not found"), strings.Contains(msg, "no such file"):
		return os.ErrNotExist
	case strings.Contains(msg, "already exists"), strings.Contains(msg, "file exists"):
		return os.ErrExist
	case strings.Contains(msg, "not in allowed list"), strings.Contains(msg, "permission denied"),
		strings.Contains(msg, "file transfer is disabled"):
		return os.ErrPermission
	case strings.Contains(msg, "not empty"):
		return errNotEmpty
	}
	return nil
}

// errNotEmpty marks a non-recursive delete of a populated directory.
var errNotEmpty = errors.New("directory not empty")

// asPathError wraps an agent failure in *os.PathError with the matching
// os sentinel so os.IsNotExist / os.IsExist / os.IsPermission (which
// x/net/webdav uses, and which only unwrap *os.PathError) recognise it.
func asPathError(op, name string, err error) error {
	var ae *AgentError
	if errors.As(err, &ae) {
		if k := ae.kind(); k != nil {
			return &os.PathError{Op: op, Path: name, Err: k}
		}
	}
	return &os.PathError{Op: op, Path: name, Err: err}
}

func (c *AgentClient) endpoint(agentID, op string) string {
	return c.baseURL + "/agents/" + url.PathEscape(agentID) + "/file/" + op
}

func (c *AgentClient) newRequest(ctx context.Context, url, contentType string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return req, nil
}

func (c *AgentClient) browse(ctx context.Context, agentID string, in browseRequest) (*browseResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, browseTimeout)
	defer cancel()
	body, _ := json.Marshal(in)
	req, err := c.newRequest(ctx, c.endpoint(agentID, "browse"), "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("agent %s %s: %w", in.Action, in.Path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("agent %s %s: read response: %w", in.Action, in.Path, err)
	}
	var out browseResponse
	jsonErr := json.Unmarshal(raw, &out)
	if resp.StatusCode != http.StatusOK || out.Error != "" {
		ae := &AgentError{Op: in.Action, Path: in.Path, Status: resp.StatusCode, Code: out.ErrorCode, Msg: out.Error}
		if jsonErr != nil {
			ae.Msg = strings.TrimSpace(string(raw))
		}
		return nil, ae
	}
	if jsonErr != nil {
		return nil, fmt.Errorf("agent %s %s: invalid JSON: %w", in.Action, in.Path, jsonErr)
	}
	return &out, nil
}

// Stat returns the entry for path.
func (c *AgentClient) Stat(ctx context.Context, agentID, path string) (FileEntry, error) {
	out, err := c.browse(ctx, agentID, browseRequest{Action: "stat", Path: path})
	if err != nil {
		return FileEntry{}, err
	}
	if out.Entry == nil {
		return FileEntry{}, &AgentError{Op: "stat", Path: path, Status: http.StatusBadGateway, Msg: "response has no entry"}
	}
	return *out.Entry, nil
}

// List returns every entry of the directory at path, paging through
// the agent's list action until it reports no truncation.
func (c *AgentClient) List(ctx context.Context, agentID, path string) ([]FileEntry, error) {
	var all []FileEntry
	for offset := 0; ; {
		out, err := c.browse(ctx, agentID, browseRequest{Action: "list", Path: path, Offset: offset, Limit: maxListPage})
		if err != nil {
			return nil, err
		}
		all = append(all, out.Entries...)
		offset += len(out.Entries)
		if !out.Truncated || len(out.Entries) == 0 {
			return all, nil
		}
		if len(all) >= maxListEntries {
			return nil, &AgentError{Op: "list", Path: path, Status: http.StatusInsufficientStorage,
				Msg: fmt.Sprintf("directory has more than %d entries", maxListEntries)}
		}
	}
}

// Mkdir creates one directory; the parent must exist.
func (c *AgentClient) Mkdir(ctx context.Context, agentID, path string) error {
	_, err := c.browse(ctx, agentID, browseRequest{Action: "mkdir", Path: path})
	return err
}

// Rename moves oldPath to newPath; fails when newPath exists.
func (c *AgentClient) Rename(ctx context.Context, agentID, oldPath, newPath string) error {
	_, err := c.browse(ctx, agentID, browseRequest{Action: "rename", Path: oldPath, NewPath: newPath})
	return err
}

// Delete removes path, recursively for a populated directory.
func (c *AgentClient) Delete(ctx context.Context, agentID, path string, recursive bool) error {
	_, err := c.browse(ctx, agentID, browseRequest{Action: "delete", Path: path, Recursive: recursive})
	return err
}

// transferError decodes the {success:false, error, code} body the
// download and upload endpoints return on failure (or a plain-text
// body from the relay).
func transferError(op, path string, resp *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var body struct {
		Error     string `json:"error"`
		Code      string `json:"code"`
		ErrorCode string `json:"error_code"`
	}
	ae := &AgentError{Op: op, Path: path, Status: resp.StatusCode}
	if json.Unmarshal(raw, &body) == nil && (body.Error != "" || body.Code != "" || body.ErrorCode != "") {
		ae.Msg, ae.Code = body.Error, body.Code
		if ae.Code == "" {
			ae.Code = body.ErrorCode
		}
	} else {
		ae.Msg = strings.TrimSpace(string(raw))
	}
	return ae
}

// ReadRange downloads up to length bytes of the file at path starting
// at offset. The returned slice is shorter than length only at EOF. An
// agent that ignores length is handled by reading just length bytes
// and dropping the connection.
func (c *AgentClient) ReadRange(ctx context.Context, agentID, path string, offset, length int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	body, _ := json.Marshal(map[string]any{"path": path, "offset": offset, "length": length})
	req, err := c.newRequest(ctx, c.endpoint(agentID, "download"), "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("agent download %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, transferError("download", path, resp)
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "application/gzip") && resp.Header.Get("X-Original-Size") == "" {
		// A directory comes back as a tar.gz; never hand that out as file content.
		return nil, &AgentError{Op: "download", Path: path, Status: http.StatusConflict, Msg: "is a directory"}
	}
	buf := make([]byte, length)
	n, err := io.ReadFull(resp.Body, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("agent download %s: %w", path, err)
	}
	return buf[:n], nil
}

// Upload writes the content of r to path, replacing any existing file
// (which keeps its mode; a new file gets the agent default).
func (c *AgentClient) Upload(ctx context.Context, agentID, path string, r io.Reader) error {
	ctx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()

	// Stream the multipart body through a pipe so a large temp file is
	// never held in memory.
	pr, pw := io.Pipe()
	// Closing the read side unblocks the writer goroutine whatever way
	// the request ends (early response, transport error, cancel).
	defer pr.Close()
	mw := multipart.NewWriter(pw)
	go func() {
		err := func() error {
			if err := mw.WriteField("path", path); err != nil {
				return err
			}
			part, err := mw.CreateFormFile("file", baseName(path))
			if err != nil {
				return err
			}
			if _, err := io.Copy(part, r); err != nil {
				return err
			}
			return mw.Close()
		}()
		pw.CloseWithError(err)
	}()

	req, err := c.newRequest(ctx, c.endpoint(agentID, "upload"), mw.FormDataContentType(), pr)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("agent upload %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return transferError("upload", path, resp)
	}
	var out struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
		Code    string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err == nil && !out.Success && out.Error != "" {
		return &AgentError{Op: "upload", Path: path, Status: resp.StatusCode, Code: out.Code, Msg: out.Error}
	}
	return nil
}

func baseName(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// parseMode turns the agent's octal mode string into permission bits.
func parseMode(s string) os.FileMode {
	v, err := strconv.ParseUint(s, 8, 32)
	if err != nil {
		return 0
	}
	return os.FileMode(v) & os.ModePerm
}

// Errors CheckDir reports for a remote path that cannot be shared.
var (
	ErrRemoteNotFound   = errors.New("remote path not found on the agent")
	ErrRemoteNotAllowed = errors.New("remote path is outside the agent's file_transfer.allowed_paths, or file transfer is not permitted")
	ErrRemoteNotDir     = errors.New("remote path is not a directory")
)

// CheckDir verifies that path exists on agentID and is a directory.
// Any other failure (agent unreachable, signing misconfigured) comes
// back wrapped as is.
func (c *AgentClient) CheckDir(ctx context.Context, agentID, path string) error {
	e, err := c.Stat(ctx, agentID, path)
	if err != nil {
		var ae *AgentError
		if errors.As(err, &ae) {
			switch ae.kind() {
			case os.ErrNotExist:
				return ErrRemoteNotFound
			case os.ErrPermission:
				return fmt.Errorf("%w: %v", ErrRemoteNotAllowed, err)
			}
		}
		return err
	}
	if !e.IsDir {
		return ErrRemoteNotDir
	}
	return nil
}
