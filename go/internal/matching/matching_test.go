package matching

import "testing"

func TestMatchesPath(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{"/users", "/users", true}, {"/users", "/users/1", false}, {"/users", "/user", false},
		{"/*", "/", true}, {"/*", "/a/b/c", true}, {"/users/*", "/users/1/posts", true}, {"/users/*", "/orders/1", false},
		{"/api/*/items", "/api/v1/items", true},
		{"/users/:id", "/users/42", true}, {"/users/:id", "/users/42/posts", false}, {"/users/:id", "/users/", false},
		{"/users/:id/posts", "/users/42/posts", true},
		{"/file.json", "/file.json", true}, {"/file.json", "/fileXjson", false}, {"/a+b", "/a+b", true}, {"/(x)", "/(x)", true},
	}
	for _, c := range cases {
		if got := MatchesPath(c.pattern, c.path); got != c.want {
			t.Errorf("MatchesPath(%q, %q) = %v, want %v", c.pattern, c.path, got, c.want)
		}
	}
}

func rule(id, typ string) Rule {
	return Rule{ID: id, Method: "*", PathPattern: "/*", Type: typ, Probability: 1, Params: map[string]any{}}
}

func always() float64 { return 0 }

func TestSelect(t *testing.T) {
	if s := Select(nil, "GET", "/x", always); s.Latency != nil || s.Terminal != nil {
		t.Fatal("no rules should select nothing")
	}

	r := rule("a", "error")
	if s := Select([]Rule{r}, "GET", "/x", func() float64 { return 0.999999 }); s.Terminal == nil {
		t.Error("probability 1 must always fire")
	}
	r.Probability = 0
	if s := Select([]Rule{r}, "GET", "/x", always); s.Terminal != nil {
		t.Error("probability 0 must never fire")
	}

	half := rule("h", "error")
	half.Probability = 0.5
	if Select([]Rule{half}, "GET", "/x", func() float64 { return 0.49 }).Terminal == nil {
		t.Error("0.49 < 0.5 should fire")
	}
	if Select([]Rule{half}, "GET", "/x", func() float64 { return 0.5 }).Terminal != nil {
		t.Error("0.5 is not < 0.5")
	}

	post := rule("p", "error")
	post.Method = "post"
	orders := rule("o", "drop")
	orders.PathPattern = "/orders/*"
	if s := Select([]Rule{post, orders}, "GET", "/users/1", always); s.Terminal != nil {
		t.Error("method and path filters should exclude both")
	}
	if s := Select([]Rule{post}, "POST", "/x", always); s.Terminal == nil || s.Terminal.ID != "p" {
		t.Error("method match is case-insensitive")
	}

	l1, l2, e, d := rule("l1", "latency"), rule("l2", "latency"), rule("e", "error"), rule("d", "drop")
	s := Select([]Rule{l1, e, l2, d}, "GET", "/x", always)
	if s.Latency.ID != "l1" || s.Terminal.ID != "e" {
		t.Errorf("first match wins: got %s, %s", s.Latency.ID, s.Terminal.ID)
	}

	first, second := rule("f", "error"), rule("s", "drop")
	first.Probability = 0.1
	rolls := []float64{0.9, 0}
	s = Select([]Rule{first, second}, "GET", "/x", func() float64 { v := rolls[0]; rolls = rolls[1:]; return v })
	if s.Terminal.ID != "s" {
		t.Error("a rule that does not fire lets a later one fire")
	}

	calls := 0
	miss := rule("m", "error")
	miss.PathPattern = "/nope"
	Select([]Rule{miss}, "GET", "/x", func() float64 { calls++; return 0 })
	if calls != 0 {
		t.Error("non-matching rules must not consume a random roll")
	}
}
