package davshare

import "time"

// ttlMap is a size-bounded map whose entries expire. It does no locking
// of its own; the owner guards it with its mutex. Adding a new key to a
// full map first sweeps expired entries and, if that frees nothing,
// starts over empty, so memory stays bounded however many keys arrive.
type ttlMap[K comparable, V any] struct {
	max int
	m   map[K]ttlEntry[V]
}

type ttlEntry[V any] struct {
	v   V
	exp time.Time
}

func newTTLMap[K comparable, V any](max int) ttlMap[K, V] {
	return ttlMap[K, V]{max: max, m: map[K]ttlEntry[V]{}}
}

// get returns the live value for k. An expired entry is dropped.
func (t *ttlMap[K, V]) get(k K, now time.Time) (V, time.Time, bool) {
	e, ok := t.m[k]
	if ok && now.Before(e.exp) {
		return e.v, e.exp, true
	}
	if ok {
		delete(t.m, k)
	}
	var zero V
	return zero, time.Time{}, false
}

// put stores v under k until exp.
func (t *ttlMap[K, V]) put(k K, v V, exp, now time.Time) {
	if _, ok := t.m[k]; !ok && len(t.m) >= t.max {
		for key, e := range t.m {
			if !now.Before(e.exp) {
				delete(t.m, key)
			}
		}
		if len(t.m) >= t.max {
			t.m = map[K]ttlEntry[V]{}
		}
	}
	t.m[k] = ttlEntry[V]{v: v, exp: exp}
}

func (t *ttlMap[K, V]) delete(k K) { delete(t.m, k) }

// deleteFunc removes every key for which drop returns true.
func (t *ttlMap[K, V]) deleteFunc(drop func(K) bool) {
	for k := range t.m {
		if drop(k) {
			delete(t.m, k)
		}
	}
}
