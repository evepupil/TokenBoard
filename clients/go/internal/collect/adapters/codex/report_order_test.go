package codex

// calculate_group_cost (report.rs:389-399) sums the group's models in
// BTreeMap order, i.e. ascending model name. Go's map iteration order is
// randomised and a float sum is order sensitive, so an unsorted accumulation
// returns different bits run to run - and forks costUSD against ccusage.

import (
	"math"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

func orderTestCorpus() *nativepricing.Corpus {
	rate := nativepricing.CorpusModel{Input: 1e-6}
	return &nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
		"a": rate,
		"m": rate,
		"z": rate,
	}}
}

func orderTestUsage(input uint64) *ModelUsage {
	return &ModelUsage{Input: input, Total: input}
}

// TestGroupCostSumsModelsInSortedOrder pins calculate_group_cost to
// BTreeMap order. The fixture is chosen so the two orderings genuinely differ
// - 1e12 plus two 5e-5 amounts loses the small terms one way and keeps one of
// them the other - so a random tie in map iteration cannot hide an unsorted
// sum: the same call is made many times and every result must match the
// sorted-order reference exactly.
func TestGroupCostSumsModelsInSortedOrder(t *testing.T) {
	corpus := orderTestCorpus()
	group := newGroup()
	group.Models["a"] = orderTestUsage(50)
	group.Models["m"] = orderTestUsage(50)
	group.Models["z"] = orderTestUsage(1_000_000_000_000_000_000)

	speed := SpeedPolicy{}
	want := ModelCost("a", group.Models["a"], corpus, time.UnixMilli(0), speed) +
		ModelCost("m", group.Models["m"], corpus, time.UnixMilli(0), speed) +
		ModelCost("z", group.Models["z"], corpus, time.UnixMilli(0), speed)
	if math.Float64bits(want) == math.Float64bits((ModelCost("z", group.Models["z"], corpus, time.UnixMilli(0), speed)+
		ModelCost("m", group.Models["m"], corpus, time.UnixMilli(0), speed))+
		ModelCost("a", group.Models["a"], corpus, time.UnixMilli(0), speed)) {
		t.Fatal("fixture is not order sensitive: sorted and reverse sums share a bit pattern")
	}

	for attempt := 0; attempt < 200; attempt++ {
		got := groupCost(group, corpus, speed)
		if math.Float64bits(got) != math.Float64bits(want) {
			t.Fatalf("attempt %d: groupCost = %v (%#x), want the sorted-order sum %v (%#x); map iteration order leaked into the total",
				attempt, got, math.Float64bits(got), want, math.Float64bits(want))
		}
	}
}
