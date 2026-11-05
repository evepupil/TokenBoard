package claude

import "strings"

// The dedupe index is the third layer of ccusage's Claude adapter: after the
// discovery layer (paths.go) picks transcripts and the line parser (entry.go)
// turns them into entries, this file decides which entries are one response's
// usage. Both collector chains run through it - the session/entry chain
// (lib.rs:170-345) and the daily chain (daily.rs:450-568) - and they differ
// only in the sidechain matcher and in one replacement rung.
//
// Upstream keeps one FxHashMap<u64, Vec<DedupeIndex>> and hashes composite
// keys. Go struct keys compare by value and cannot collide, so the map here is
// keyed by routeKey: same semantics with strictly fewer false matches (the
// predicate in every bucket would reject a colliding hash anyway). Route is
// part of the key, so the zero value of a route's unused fields never collides
// with another route. All rules cite ccusage v20.0.33 (commit 1308c416).

// DedupeMode selects which loader's dedupe rules apply.
type DedupeMode uint8

const (
	// DedupeEntry is the session/entry chain (lib.rs).
	DedupeEntry DedupeMode = iota
	// DedupeDaily is the daily chain (daily.rs).
	DedupeDaily
)

// route names the upstream hash family a bucket belongs to.
type route uint8

const (
	routeExact          route = 0 // lib.rs:344 usage_dedupe_hash
	routeSidechainRepl  route = 1 // lib.rs:377 "sidechain-replay"
	routeSidechainEntry route = 2 // lib.rs:386 "sidechain-replay-entry"
)

// routeKey is the composite dedupe key. Which fields are filled follows the
// upstream hash construction: the exact key always carries the message and
// request ids, and adds the session id only when there is no request id, plus
// the timestamp only when there is no request id and the message id is not an
// Anthropic one (lib.rs:350-373). The two sidechain routes always carry the
// message id and session id only (lib.rs:377-392).
type routeKey struct {
	route       route
	messageID   string
	requestID   string // exact key: "" means the entry had no request_id
	sessionID   string // exact key only when requestID == ""; sidechain keys always
	timestampMs int64  // exact key only when requestID == "" and the id is not msg_
}

// dedupeIndex is one bucket member (upstream DedupeIndex, lib.rs:39-45).
type dedupeIndex struct {
	index        int
	sessionAlias string // "" means no alias (upstream session_alias: None)
}

// Dedupe is one load's global dedupe index. It spans every file and every root
// of a single collection (lib.rs:170-182), so callers must Add entries in
// file-path order and then line order; that order decides which tied entry
// survives.
type Dedupe struct {
	mode    DedupeMode
	indexes map[routeKey][]dedupeIndex
	entries []Entry
}

// NewDedupe returns an empty index for one collector chain. An unknown mode is
// a construction bug, not runtime data, so it panics rather than silently
// falling back to one chain's rules.
func NewDedupe(mode DedupeMode) *Dedupe {
	if mode != DedupeEntry && mode != DedupeDaily {
		panic("claude: unknown dedupe mode")
	}
	return &Dedupe{mode: mode, indexes: map[routeKey][]dedupeIndex{}}
}

// Add folds one entry into the index, replacing an earlier survivor when the
// candidate wins the replacement ladder (push_deduped_entry, lib.rs:214-345,
// and push_deduped_daily_entry, daily.rs:450-568). It has no failure path:
// upstream dedupe cannot fail.
//
// The cost fields are read, never computed: ccusage prices every entry before
// dedup (daily.rs:323-330) because the daily replacement compares Cost.
func (d *Dedupe) Add(entry Entry) {
	// Upstream wraps the whole lookup in `message.id.as_deref().map(...)`
	// (lib.rs:219): an entry without a message id is appended unindexed and
	// never matches anything.
	if entry.MessageID == "" {
		d.entries = append(d.entries, entry)
		return
	}

	sessionID := entry.dedupeSessionID()
	timestampMs := entry.Timestamp.UnixMilli()
	exact := exactKey(entry.MessageID, entry.RequestID, sessionID, timestampMs)

	index, matched := d.lookup(exact, entry, sessionID, timestampMs)
	if matched {
		// Cross-session copies can become the survivor, so every session route
		// a later sidechain replay may use has to point at the shared index
		// (lib.rs:270-286, daily.rs:504-520).
		existingSessionID := d.entries[index].dedupeSessionID()
		if sessionID != existingSessionID {
			for _, sid := range [2]string{sessionID, existingSessionID} {
				d.pushAlias(sidechainKey(routeSidechainRepl, entry.MessageID, sid), index, sid)
				d.pushAlias(sidechainKey(routeSidechainEntry, entry.MessageID, sid), index, sid)
			}
		}
		if !d.shouldReplace(entry, d.entries[index]) {
			return
		}
		previous := d.entries[index]
		d.entries[index] = entry
		// The survivor is already indexed under its previous keys. Only
		// register the keys that changed, so repeated same-timestamp rewrites
		// do not rescan large buckets (lib.rs:288-319, daily.rs:522-551).
		if previous.MessageID == "" || exactKey(previous.MessageID, previous.RequestID, previous.dedupeSessionID(), previous.Timestamp.UnixMilli()) != exact {
			d.pushIndex(exact, index)
		}
		replayRouteChanged := previous.dedupeSessionID() != entry.dedupeSessionID() ||
			previous.Sidechain != entry.Sidechain ||
			previous.MessageID != entry.MessageID
		if replayRouteChanged {
			sid := entry.dedupeSessionID()
			d.pushIndex(sidechainKey(routeSidechainRepl, entry.MessageID, sid), index)
			if entry.Sidechain {
				d.pushIndex(sidechainKey(routeSidechainEntry, entry.MessageID, sid), index)
			}
		}
		return
	}

	index = len(d.entries)
	d.entries = append(d.entries, entry)
	// `index` is new, so none of these buckets can already hold it
	// (lib.rs:323-345, daily.rs:553-568).
	d.pushNewIndex(exact, index)
	d.pushNewIndex(sidechainKey(routeSidechainRepl, entry.MessageID, sessionID), index)
	if entry.Sidechain {
		d.pushNewIndex(sidechainKey(routeSidechainEntry, entry.MessageID, sessionID), index)
	}
}

// Entries returns the survivors in first-seen order.
func (d *Dedupe) Entries() []Entry {
	return append([]Entry(nil), d.entries...)
}

// lookup is the two-step search of lib.rs:222-268 (and daily.rs:459-502): the
// exact bucket first, and only when it misses the sidechain bucket selected by
// the candidate's own sidechain flag.
func (d *Dedupe) lookup(exact routeKey, entry Entry, sessionID string, timestampMs int64) (int, bool) {
	for _, indexed := range d.indexes[exact] {
		if d.matchesExact(d.entries[indexed.index], entry, sessionID, timestampMs) {
			return indexed.index, true
		}
	}

	// /btw sidechain logs can replay parent messages with new request IDs. A
	// replay needs a sidechain on at least one side, so a parent candidate only
	// has to look through sidechain entries; this keeps gateway logs that reuse
	// one message ID for every response from rescanning all earlier entries
	// (lib.rs:235-266).
	bucketRoute := routeSidechainEntry
	if entry.Sidechain {
		bucketRoute = routeSidechainRepl
	}
	for _, indexed := range d.indexes[sidechainKey(bucketRoute, entry.MessageID, sessionID)] {
		existing := d.entries[indexed.index]
		indexedSessionID := indexed.sessionAlias
		if indexedSessionID == "" {
			indexedSessionID = existing.dedupeSessionID()
		}
		// The bucket key already fixes the session, so this check can only
		// fail if a key were constructed wrongly; it stays because upstream
		// tests it on every member (lib.rs:251-255, daily.rs:492-496).
		if indexedSessionID == sessionID && d.matchesSidechain(existing, entry, timestampMs) {
			return indexed.index, true
		}
	}
	return 0, false
}

// matchesExact is loaded_entry_matches_dedupe_key (lib.rs:413-425) and its
// daily twin (daily.rs:461-467).
func (d *Dedupe) matchesExact(existing, candidate Entry, sessionID string, timestampMs int64) bool {
	if existing.MessageID != candidate.MessageID || existing.RequestID != candidate.RequestID {
		return false
	}
	if candidate.RequestID != "" {
		return true
	}
	return existing.dedupeSessionID() == sessionID &&
		(isAnthropicMessageID(candidate.MessageID) || existing.Timestamp.UnixMilli() == timestampMs)
}

// matchesSidechain is loaded_entry_matches_sidechain_dedupe_key
// (lib.rs:427-440) or its daily twin (daily.rs:486-498). The daily variant has
// no timestamp condition: requestless replays match across timestamps, and
// replays with a new request id match too, because their session route points
// at the parent.
func (d *Dedupe) matchesSidechain(existing, candidate Entry, timestampMs int64) bool {
	if existing.MessageID != candidate.MessageID {
		return false
	}
	if d.mode == DedupeEntry {
		requestless := candidate.RequestID == "" && existing.RequestID == ""
		if !requestless && existing.Timestamp.UnixMilli() != timestampMs {
			return false
		}
	}
	return candidate.Sidechain || existing.Sidechain
}

// shouldReplace is should_replace_deduped_entry (lib.rs:198-212) and
// should_replace_deduped_daily_entry (daily.rs:582-601).
func (d *Dedupe) shouldReplace(candidate, existing Entry) bool {
	if candidate.Sidechain != existing.Sidechain {
		// A non-sidechain entry wins over a sidechain replay.
		return existing.Sidechain
	}
	candidateTotal := dedupeTokenTotal(candidate)
	existingTotal := dedupeTokenTotal(existing)
	if candidateTotal != existingTotal {
		return candidateTotal > existingTotal
	}
	// Only the daily chain compares cost, and it sits between the token rung
	// and the speed rung (daily.rs:592-596).
	if d.mode == DedupeDaily && candidate.Cost != existing.Cost {
		return candidate.Cost > existing.Cost
	}
	return candidate.Usage.Speed != "" && existing.Usage.Speed == ""
}

// pushIndex registers a bucket member, skipping one that is already present
// without an alias (push_deduped_index, lib.rs:443-461).
func (d *Dedupe) pushIndex(key routeKey, index int) {
	bucket := d.indexes[key]
	for _, existing := range bucket {
		if existing.index == index && existing.sessionAlias == "" {
			return
		}
	}
	d.indexes[key] = append(bucket, dedupeIndex{index: index})
}

// pushNewIndex registers a brand-new survivor, which by construction cannot be
// in the bucket yet (push_new_deduped_index, lib.rs:463-471).
func (d *Dedupe) pushNewIndex(key routeKey, index int) {
	d.indexes[key] = append(d.indexes[key], dedupeIndex{index: index})
}

// pushAlias registers a session alias for one survivor, skipping a duplicate
// (push_deduped_session_alias, lib.rs:473-490). An alias records that a
// replay arriving through sessionID still points at this survivor, even when
// the survivor belongs to another session.
func (d *Dedupe) pushAlias(key routeKey, index int, sessionID string) {
	bucket := d.indexes[key]
	for _, existing := range bucket {
		if existing.index == index && existing.sessionAlias == sessionID {
			return
		}
	}
	d.indexes[key] = append(bucket, dedupeIndex{index: index, sessionAlias: sessionID})
}

func exactKey(messageID, requestID, sessionID string, timestampMs int64) routeKey {
	key := routeKey{route: routeExact, messageID: messageID, requestID: requestID}
	if requestID == "" {
		key.sessionID = sessionID
		if !isAnthropicMessageID(messageID) {
			key.timestampMs = timestampMs
		}
	}
	return key
}

func sidechainKey(bucket route, messageID, sessionID string) routeKey {
	return routeKey{route: bucket, messageID: messageID, sessionID: sessionID}
}

// isAnthropicMessageID is is_anthropic_message_id (lib.rs:373-375): real
// Anthropic ids are unique per response, unlike the placeholder ids gateways
// reuse for every response.
func isAnthropicMessageID(messageID string) bool {
	return strings.HasPrefix(messageID, "msg_")
}

// dedupeSessionID is loaded_entry_session_id (lib.rs:405-411): the serialized
// sessionId when the line carried one, otherwise the id derived from the file
// path. Env-empty ids are rejected at parse time, so "" means "absent".
func (e Entry) dedupeSessionID() string {
	if e.SessionID != "" {
		return e.SessionID
	}
	return e.PathSessionID
}

// dedupeTokenTotal is usage_token_total (lib.rs:190-196) and
// daily_usage_token_total (daily.rs:443-448): the sum of the four token
// buckets, with cache creation read from the normalized 5m+1h pair, which
// equals cache_creation_token_count (types.rs:42-49).
//
// Upstream adds u64 values with plain +, and so does this: the parser bounds
// every field at math.MaxInt64, and a real transcript line cannot approach a
// sum that overflows int64.
func dedupeTokenTotal(entry Entry) int64 {
	return entry.Usage.Input + entry.Usage.Output +
		entry.Usage.CacheCreate5m + entry.Usage.CacheCreate1h + entry.Usage.CacheRead
}
