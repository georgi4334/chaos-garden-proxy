package matching

import "strings"

// Rule is one fault rule, as the control API sends it.
type Rule struct {
	ID          string         `json:"id"`
	Method      string         `json:"method"`
	PathPattern string         `json:"pathPattern"`
	Type        string         `json:"type"` // latency | error | drop | corrupt
	Probability float64        `json:"probability"`
	Params      map[string]any `json:"params"`
}

// Selection is what to do with one request: at most one latency rule, applied
// first, and at most one of error, drop or corrupt.
type Selection struct {
	Latency  *Rule
	Terminal *Rule
}

// Select walks the rules in order (oldest first). A rule is eligible when its
// method and path match; it then fires with its own probability. random must
// return a number in [0, 1), so probability 0 never fires and 1 always does.
func Select(rules []Rule, method, path string, random func() float64) Selection {
	var s Selection
	for i := range rules {
		if s.Latency != nil && s.Terminal != nil {
			break
		}
		r := &rules[i]
		if r.Method != "*" && !strings.EqualFold(r.Method, method) {
			continue
		}
		if !MatchesPath(r.PathPattern, path) {
			continue
		}
		if r.Type == "latency" {
			if s.Latency == nil && random() < r.Probability {
				s.Latency = r
			}
		} else if s.Terminal == nil && random() < r.Probability {
			s.Terminal = r
		}
	}
	return s
}
