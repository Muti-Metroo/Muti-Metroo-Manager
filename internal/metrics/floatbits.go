package metrics

import "math"

// float64ToBits / float64FromBits wrap math.Float* so atomicFloat's
// add loop reads cleaner. Inlined by the compiler — no overhead.
func float64ToBits(v float64) uint64   { return math.Float64bits(v) }
func float64FromBits(b uint64) float64 { return math.Float64frombits(b) }
