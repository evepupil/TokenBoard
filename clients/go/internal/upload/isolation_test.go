package upload

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// isolationServer rejects any ingest batch containing a row whose Model is
// "bad", naming the first such row exactly as the server's error.details does.
// All other batches succeed, and /check is unsupported so every row is posted.
func isolationServer(t *testing.T, ingestCalls *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		atomic.AddInt32(ingestCalls, 1)
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for index, snapshot := range body.Snapshots {
			if snapshot.Model == "bad" {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"code":    "BAD_REQUEST",
						"message": "Invalid request",
						"details": []map[string]any{{
							"index": index,
							"path":  "snapshots." + strconv.Itoa(index) + ".usageDate",
							"code":  "usage-date-too-far-future",
						}},
					},
				})
				return
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
	}))
}

func TestUploadIsolatesRowsTheServerNames(t *testing.T) {
	var ingestCalls int32
	server := isolationServer(t, &ingestCalls)
	defer server.Close()

	good := baseSnapshot("good", 10)
	bad := baseSnapshot("bad", 20)
	also := baseSnapshot("also-good", 30)

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL),
		[]contract.Snapshot{good, bad, also}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 2 {
		t.Errorf("upserted = %d, want 2", result.Upserted)
	}
	if len(result.Blocked) != 1 || result.Blocked[0].Snapshot.Model != "bad" {
		t.Fatalf("blocked = %+v, want the bad row", result.Blocked)
	}
	if result.Blocked[0].Code != "usage-date-too-far-future" {
		t.Errorf("blocked code = %q", result.Blocked[0].Code)
	}
	// A blocked row never reached the server, so the cursor must not acknowledge it.
	for _, delivered := range result.Delivered {
		if delivered.Model == "bad" {
			t.Fatalf("blocked row reported as delivered: %+v", result.Delivered)
		}
	}
	if len(result.Delivered) != 2 {
		t.Errorf("delivered = %d, want 2", len(result.Delivered))
	}
	if got := atomic.LoadInt32(&ingestCalls); got != 2 {
		t.Errorf("ingest calls = %d, want 2 (reject, then resend the rest)", got)
	}
}

// A server that keeps naming rows must not be able to loop the client: after
// two removal rounds the batch fails like it does today.
func TestUploadStopsIsolatingAfterTwoRounds(t *testing.T) {
	var ingestCalls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		atomic.AddInt32(&ingestCalls, 1)
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if len(body.Snapshots) == 0 {
			_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"details": []map[string]any{{
				"index": 0, "path": "snapshots.0.model", "code": "invalid-value",
			}}},
		})
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{
		baseSnapshot("a", 1), baseSnapshot("b", 2), baseSnapshot("c", 3),
	}, server.Client())
	if err == nil {
		t.Fatal("expected an error once the isolation rounds are exhausted")
	}
	if !strings.Contains(err.Error(), "Upload failed with status 400") {
		t.Errorf("error = %v", err)
	}
}

// An old server answers 400 without details; the client must fail the batch as
// a whole and never re-send it (no details, no idea which row is at fault).
func TestUploadWithoutDetailsFailsWholeBatch(t *testing.T) {
	var ingestCalls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		atomic.AddInt32(&ingestCalls, 1)
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "BAD_REQUEST", "message": "Invalid request"},
		})
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL),
		[]contract.Snapshot{baseSnapshot("a", 1)}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "Upload failed with status 400") {
		t.Fatalf("err = %v", err)
	}
	if got := atomic.LoadInt32(&ingestCalls); got != 1 {
		t.Errorf("ingest calls = %d, want 1", got)
	}
}

// A rejected key in the /check request is dropped and the remaining keys are
// checked again; the row stays in the upload list (ingest isolation decides it).
func TestCheckDropsRejectedKeysAndRetries(t *testing.T) {
	var checkCalls int32
	var checkedKeys int32
	var upserted int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			call := atomic.AddInt32(&checkCalls, 1)
			var body struct {
				Keys []struct{ Model string } `json:"keys"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			atomic.AddInt32(&checkedKeys, int32(len(body.Keys)))
			if call == 1 {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{"details": []map[string]any{{
						"index": 0, "path": "keys.0.usageDate", "code": "invalid-date",
					}}},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		atomic.AddInt32(&upserted, int32(len(body.Snapshots)))
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{
		baseSnapshot("a", 1), baseSnapshot("b", 2),
	}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 2 {
		t.Errorf("upserted = %d, want 2", result.Upserted)
	}
	if got := atomic.LoadInt32(&checkCalls); got != 2 {
		t.Errorf("check calls = %d, want 2", got)
	}
	// First check had 2 keys, the retry 1 (the rejected one was dropped).
	if got := atomic.LoadInt32(&checkedKeys); got != 3 {
		t.Errorf("checked keys total = %d, want 3", got)
	}
	if got := atomic.LoadInt32(&upserted); got != 2 {
		t.Errorf("upserted rows = %d, want 2", got)
	}
}
