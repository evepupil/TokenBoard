package nativepricing

// ccusage's model alias map: model_aliases.rs (CCUSAGE_MODEL_ALIASES). Moved
// here from the Claude adapter when find_at needed the same resolver
// (pricing.rs:1460 calls resolve_model_name); both the pricing lookup and every
// adapter's display names must agree on it, so there is one implementation.

import (
	"encoding/json"
	"os"
	"strings"
)

// ModelAliasesEnv is ccusage's CCUSAGE_MODEL_ALIASES (model_aliases.rs:8).
const ModelAliasesEnv = "CCUSAGE_MODEL_ALIASES"

// ResolveModelName is resolve_model_name (model_aliases.rs:14-26) with the
// "-fast" suffix ccusage appends for the fast service tier.
func ResolveModelName(model string) string {
	return ResolveModelNameWithSuffix(model, "-fast")
}

// ResolveModelNameWithSuffix is resolve_model_name with a caller-chosen
// fast-tier suffix: a direct alias wins, and otherwise a suffixed name is
// looked up by its base and the alias gains the suffix back.
//
// Upstream parses the variable once into a OnceLock; reading it on every call
// is observably identical and lets tests drive it with t.Setenv.
func ResolveModelNameWithSuffix(model, fastSuffix string) string {
	aliases := ModelAliases(os.Getenv(ModelAliasesEnv))
	if alias := aliases[model]; alias != "" {
		return alias
	}
	if base, ok := strings.CutSuffix(model, fastSuffix); ok {
		if alias := aliases[base]; alias != "" {
			return alias + fastSuffix
		}
	}
	return model
}

// ModelAliases is parse_model_aliases (model_aliases.rs:39-61).
//
// A value that starts with '{' is first read as a JSON object of strings; any
// failure - a syntax error, a non-string value, trailing bytes - falls through
// to the delimited form, which is how serde's all-or-nothing
// BTreeMap<String, String> parse behaves. The delimited form strips at most one
// leading '{' with a matching trailing '}', splits on ',' ';' or newline, cuts
// each segment at its first '=', trims both sides and drops empty keys or
// values. A later pair overwrites an earlier one, like collect() into a
// BTreeMap.
func ModelAliases(raw string) map[string]string {
	aliases := map[string]string{}
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "{") {
		if parsed, ok := parseJSONAliases(trimmed); ok {
			return parsed
		}
	}
	stripped := trimmed
	if inner, ok := strings.CutPrefix(trimmed, "{"); ok {
		if rest, ok := strings.CutSuffix(inner, "}"); ok {
			stripped = rest
		}
	}
	for _, pair := range splitAliasPairs(stripped) {
		from, to, ok := strings.Cut(pair, "=")
		if !ok {
			continue
		}
		from = strings.TrimSpace(from)
		to = strings.TrimSpace(to)
		if from == "" || to == "" {
			continue
		}
		aliases[from] = to
	}
	return aliases
}

// parseJSONAliases decodes a JSON object whose every value is a string, and
// reports false for anything serde's BTreeMap<String, String> would reject.
func parseJSONAliases(raw string) (map[string]string, bool) {
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil || decoded == nil {
		return nil, false
	}
	aliases := make(map[string]string, len(decoded))
	for key, value := range decoded {
		text, ok := value.(string)
		if !ok {
			return nil, false
		}
		aliases[key] = text
	}
	return aliases, true
}

// splitAliasPairs keeps the plain-split semantics of Rust's
// split([',', ';', '\n']): empty segments are produced and then skipped by the
// caller because they carry no '='.
func splitAliasPairs(raw string) []string {
	return strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n'
	})
}
