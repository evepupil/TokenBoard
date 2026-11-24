package pricing

import "encoding/json"

// Scope names one ccusage report, matching the `ccusage <agent> <report>`
// invocation the collectors use (claudecode runs `ccusage claude daily`).
type Scope struct {
	Agent  string
	Report string
}

// ScopePricing is the pricing state ccusage resolves for one report from the
// config file it was pointed at.
type ScopePricing struct {
	// Overrides is the effective pricingOverrides block: root defaults plus
	// every scoped layer, merged field by field with later layers winning.
	Overrides map[string]any
	// Mode is the cost mode ccusage would use: "auto", "calculate" or
	// "display".
	Mode string
	// Speed is the Codex speed the config names: "auto", "standard", "fast"
	// or "flex" (ConfigCodexSpeed). apply_config_to_agent_args reads it from
	// the same option maps as mode and pricingOverrides, but only the Codex
	// provider consumes it.
	Speed string
}

// overrideFieldNames are the members merge_override_fields copies
// (ccusage-config/src/config.rs:639-697). Upstream drops anything else -
// including snake_case spellings and unknown keys - when it parses a scoped
// layer, so a scoped override that only carries an unknown key is an empty
// override rather than a whole-entry replacement.
var overrideFieldNames = []string{
	"inputCostPerToken",
	"outputCostPerToken",
	"cacheCreationInputTokenCost",
	"cacheReadInputTokenCost",
	"inputCostPerTokenAbove200kTokens",
	"outputCostPerTokenAbove200kTokens",
	"cacheCreationInputTokenCostAbove200kTokens",
	"cacheReadInputTokenCostAbove200kTokens",
	"maxInputTokens",
	"fastMultiplier",
	"flexMultiplier",
}

// ResolveScope returns the pricing options ccusage applies to one report.
//
// It mirrors ConfigContext::option_maps (ccusage-config/src/config.rs:92-137)
// for `ccusage <agent> <report>`: the layers are, in application order, root
// `defaults`, `commands["<agent> <report>"]`, `commands["<report>"]`,
// `commands["<agent>:<report>"]`, `<agent>.defaults` and
// `<agent>.commands["<report>"]`. Every layer is optional. The native
// providers must bill from the result instead of MergedPricingOverrides, or a
// user who sets `claude.defaults.pricingOverrides` gets one price from ccusage
// and another from the in-process pricer.
//
// Malformed values are ignored exactly the way ccusage ignores them:
// ConfigContext::from_map parses each layer with serde's `.ok()`, so a layer
// whose `mode` or `pricingOverrides` fails to parse contributes nothing
// instead of failing the run. That leniency is deliberate - matching ccusage
// matters more here than rejecting input ccusage itself would accept.
func (p PreparedConfig) ResolveScope(scope Scope) ScopePricing {
	result := ScopePricing{Overrides: map[string]any{}, Mode: "auto", Speed: "auto"}
	for _, layer := range scopeLayers(p.ccusageConfig, scope) {
		if value, ok := layer["pricingOverrides"]; ok && value != nil {
			if overrides, ok := value.(map[string]any); ok {
				if parsed, ok := parseScopeOverrides(overrides); ok {
					mergeScopeOverrides(result.Overrides, parsed)
				}
			}
		}
		if value, ok := layer["mode"]; ok && value != nil {
			if mode, ok := value.(string); ok {
				switch mode {
				case "auto", "calculate", "display":
					result.Mode = mode
				}
			}
		}
		// CodexOptions::from_map parses `speed` into a ConfigCodexSpeed enum
		// through serde, so anything outside the four lowercase names is
		// ignored and the previous layer's value stands.
		if value, ok := layer["speed"]; ok && value != nil {
			if speed, ok := value.(string); ok {
				switch speed {
				case "auto", "standard", "fast", "flex":
					result.Speed = speed
				}
			}
		}
	}
	return result
}

// scopeLayers lists the option maps ccusage consults, in ascending precedence.
func scopeLayers(config map[string]any, scope Scope) []map[string]any {
	if config == nil {
		return nil
	}
	var layers []map[string]any
	if defaults, ok := config["defaults"].(map[string]any); ok {
		layers = append(layers, defaults)
	}
	commands, _ := config["commands"].(map[string]any)
	if commands != nil {
		if command, ok := commands[scope.Agent+" "+scope.Report].(map[string]any); ok {
			layers = append(layers, command)
		}
		if scope.Agent != "" {
			if report, ok := commands[scope.Report].(map[string]any); ok {
				layers = append(layers, report)
			}
			if agentReport, ok := commands[scope.Agent+":"+scope.Report].(map[string]any); ok {
				layers = append(layers, agentReport)
			}
		}
	}
	if scope.Agent != "" {
		if agent, ok := config[scope.Agent].(map[string]any); ok {
			if defaults, ok := agent["defaults"].(map[string]any); ok {
				layers = append(layers, defaults)
			}
			if agentCommands, ok := agent["commands"].(map[string]any); ok {
				if report, ok := agentCommands[scope.Report].(map[string]any); ok {
					layers = append(layers, report)
				}
			}
		}
	}
	return layers
}

// parseScopeOverrides applies serde's all-or-nothing parse of one layer's
// pricingOverrides: every entry must be an object and every known member must
// be a number (or null), or the whole layer is discarded. Only the known
// members survive, matching ConfigPricingOverride.
func parseScopeOverrides(overrides map[string]any) (map[string]any, bool) {
	parsed := make(map[string]any, len(overrides))
	for model, value := range overrides {
		record, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		fields := map[string]any{}
		for _, name := range overrideFieldNames {
			field, present := record[name]
			if !present || field == nil {
				continue
			}
			if !isJSONNumber(field) {
				return nil, false
			}
			fields[name] = field
		}
		parsed[model] = fields
	}
	return parsed, true
}

func isJSONNumber(value any) bool {
	// The same set the override parser accepts: decoded JSON gives float64 (or
	// json.Number through the UseNumber decoder this package uses), and a
	// hand-built map may carry ints.
	switch value.(type) {
	case float64, float32, int, int64, json.Number:
		return true
	default:
		return false
	}
}

// mergeScopeOverrides merges one parsed layer into the accumulation, field by
// field (merge_pricing_overrides / merge_override_fields). A model's known
// fields only grow: an entry that carries no known field still creates an
// empty entry, exactly like BTreeMap::entry(model).or_default().
func mergeScopeOverrides(target, layer map[string]any) {
	for model, value := range layer {
		fields, _ := target[model].(map[string]any)
		base := make(map[string]any, len(fields)+len(overrideFieldNames))
		for key, field := range fields {
			base[key] = field
		}
		incoming, _ := value.(map[string]any)
		for key, field := range incoming {
			base[key] = field
		}
		target[model] = base
	}
}
