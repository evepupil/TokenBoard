package codex

import (
	"errors"
	"math"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// Port of codex-subagent-usage-math.ts: the arithmetic the subagent usage
// correction runs. The correction subtracts a parent's child-session usage
// from the parent's totals; these helpers keep the subtraction from going
// negative and spread a corrected total back across the models it came from.

// Metric is one (date, model) usage amount with its cost.
type Metric struct {
	UsageDate           string
	Model               string
	InputTokens         float64
	OutputTokens        float64
	CacheCreationTokens float64
	CacheReadTokens     float64
	TotalTokens         float64
	CostUSD             float64
}

// SnapshotKey groups metrics the way the aggregate keys do.
func SnapshotKey(usageDate, model string) string {
	return usageDate + "\x00" + model
}

// AddMetric accumulates one metric into a keyed map.
func AddMetric(adjustments map[string]Metric, metric Metric) {
	key := SnapshotKey(metric.UsageDate, metric.Model)
	current, ok := adjustments[key]
	if !ok {
		adjustments[key] = metric
		return
	}
	current.InputTokens += metric.InputTokens
	current.OutputTokens += metric.OutputTokens
	current.CacheCreationTokens += metric.CacheCreationTokens
	current.CacheReadTokens += metric.CacheReadTokens
	current.TotalTokens += metric.TotalTokens
	current.CostUSD += metric.CostUSD
	adjustments[key] = current
}

// SubtractMetric subtracts one metric from another, failing closed when the
// right side exceeds the left.
func SubtractMetric(left, right Metric) (Metric, error) {
	label := left.UsageDate + "/" + left.Model
	inputTokens, err := subtractNonNegative(left.InputTokens, right.InputTokens, label)
	if err != nil {
		return Metric{}, err
	}
	outputTokens, err := subtractNonNegative(left.OutputTokens, right.OutputTokens, label)
	if err != nil {
		return Metric{}, err
	}
	cacheCreation, err := subtractNonNegative(left.CacheCreationTokens, right.CacheCreationTokens, label)
	if err != nil {
		return Metric{}, err
	}
	cacheRead, err := subtractNonNegative(left.CacheReadTokens, right.CacheReadTokens, label)
	if err != nil {
		return Metric{}, err
	}
	totalTokens, err := subtractNonNegative(left.TotalTokens, right.TotalTokens, label)
	if err != nil {
		return Metric{}, err
	}
	costUsd, err := subtractNonNegative(left.CostUSD, right.CostUSD, label)
	if err != nil {
		return Metric{}, err
	}
	return Metric{
		UsageDate:           left.UsageDate,
		Model:               left.Model,
		InputTokens:         inputTokens,
		OutputTokens:        outputTokens,
		CacheCreationTokens: cacheCreation,
		CacheReadTokens:     cacheRead,
		TotalTokens:         totalTokens,
		CostUSD:             costUsd,
	}, nil
}

// SumMetrics adds metrics that share a date and model, keeping the first
// metric's identity.
func SumMetrics(metrics []Metric) (Metric, error) {
	if len(metrics) == 0 {
		return Metric{}, errors.New("Codex subagent session row has no model metrics")
	}
	first := metrics[0]
	total := first
	total.InputTokens = 0
	total.OutputTokens = 0
	total.CacheCreationTokens = 0
	total.CacheReadTokens = 0
	total.TotalTokens = 0
	total.CostUSD = 0
	for _, metric := range metrics {
		total.InputTokens += metric.InputTokens
		total.OutputTokens += metric.OutputTokens
		total.CacheCreationTokens += metric.CacheCreationTokens
		total.CacheReadTokens += metric.CacheReadTokens
		total.TotalTokens += metric.TotalTokens
		total.CostUSD += metric.CostUSD
	}
	return total, nil
}

// DistributeMetric spreads a corrected total across the original rows by token
// share, with the last row absorbing the remainder so the parts sum exactly.
func DistributeMetric(total Metric, originals []Metric) []Metric {
	weights := make([]float64, len(originals))
	for index, original := range originals {
		weights[index] = original.TotalTokens
	}
	inputTokens := splitInteger(total.InputTokens, weights)
	outputTokens := splitInteger(total.OutputTokens, weights)
	cacheCreationTokens := splitInteger(total.CacheCreationTokens, weights)
	cacheReadTokens := splitInteger(total.CacheReadTokens, weights)
	totalTokens := splitInteger(total.TotalTokens, weights)
	weightSum := sumWeights(weights)
	out := make([]Metric, len(originals))
	for index, original := range originals {
		out[index] = original
		out[index].InputTokens = inputTokens[index]
		out[index].OutputTokens = outputTokens[index]
		out[index].CacheCreationTokens = cacheCreationTokens[index]
		out[index].CacheReadTokens = cacheReadTokens[index]
		out[index].TotalTokens = totalTokens[index]
		out[index].CostUSD = ProrateCost(total.CostUSD, original.TotalTokens, weightSum)
	}
	return out
}

// ProrateCost scales a cost by the corrected/original token ratio.
func ProrateCost(costUsd, correctedTokens, originalTokens float64) float64 {
	if originalTokens > 0 {
		return costUsd * (correctedTokens / originalTokens)
	}
	return 0
}

// subtractNonNegative allows a tiny float undershoot, then clamps to zero;
// anything larger is a correction that exceeded the parent's usage and must
// fail closed rather than upload negative or invented numbers.
func subtractNonNegative(left, right float64, label string) (float64, error) {
	value := left - right
	if value < -0.000001 {
		return 0, errors.New("Codex subagent usage correction exceeded " + label)
	}
	if value > 0 {
		return value, nil
	}
	return 0, nil
}

func splitInteger(total float64, weights []float64) []float64 {
	if len(weights) == 0 {
		return nil
	}
	weightSum := sumWeights(weights)
	if weightSum == 0 {
		return splitEvenly(total, len(weights))
	}
	remaining := total
	out := make([]float64, len(weights))
	for index, weight := range weights {
		if index == len(weights)-1 {
			out[index] = remaining
			continue
		}
		value := math.Floor(total * (weight / weightSum))
		remaining -= value
		out[index] = value
	}
	return out
}

func splitEvenly(total float64, count int) []float64 {
	base := math.Floor(total / float64(count))
	// The TS side computes `total - base * count` as two rounded JavaScript
	// operations. Inlining it here lets the arm64 compiler fuse the multiply
	// and subtract into one FMSUBD, which rounds once and can differ by 1 ULP;
	// the helpers keep the two steps apart the way the doubles are.
	remainder := nativepricing.Sum(total, -nativepricing.Product(base, float64(count)))
	out := make([]float64, count)
	for index := 0; index < count; index++ {
		if float64(index) < remainder {
			out[index] = base + 1
			continue
		}
		out[index] = base
	}
	return out
}

func sumWeights(weights []float64) float64 {
	total := 0.0
	for _, value := range weights {
		total += value
	}
	return total
}
