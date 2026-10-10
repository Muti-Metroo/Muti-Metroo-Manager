package server

import "time"

// nowFunc lets tests freeze time; production code never reassigns it.
var nowFunc = time.Now
