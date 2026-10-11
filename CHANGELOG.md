# Changelog

## [0.2.40](https://github.com/postalsys/Muti-Metroo-Manager/compare/metroo-manager-v0.2.39...metroo-manager-v0.2.40) (2026-10-11)


### Bug Fixes

* **frontend:** add React error boundaries for the app and agent panels ([ee3d049](https://github.com/postalsys/Muti-Metroo-Manager/commit/ee3d049b085d021dbc761f7ba7a3896bcca67cb1)), closes [#17](https://github.com/postalsys/Muti-Metroo-Manager/issues/17)
* **frontend:** FilesTab render cap, upload abort, blob URL leak, dead ternary ([9410eec](https://github.com/postalsys/Muti-Metroo-Manager/commit/9410eec7cf68c8dadfea8fe2a088da441ee81e02)), closes [#18](https://github.com/postalsys/Muti-Metroo-Manager/issues/18)
* **frontend:** guard dashboard refresh against overlap, pause polling in hidden tabs ([99c904f](https://github.com/postalsys/Muti-Metroo-Manager/commit/99c904f02f1e88628b2ba2500e75b108f8d29508)), closes [#20](https://github.com/postalsys/Muti-Metroo-Manager/issues/20)
* **frontend:** keep shell sessions alive across panel-tab switches, pause hidden pings ([daacd07](https://github.com/postalsys/Muti-Metroo-Manager/commit/daacd07300b4fd788a7cf5a15914e16a8759de64)), closes [#19](https://github.com/postalsys/Muti-Metroo-Manager/issues/19)
* **frontend:** shared tab resource hook, RoutesTab validation, lazy xterm ([ad12a66](https://github.com/postalsys/Muti-Metroo-Manager/commit/ad12a669cbda6114f56ac2e8555a2e0a4cc0a3af)), closes [#21](https://github.com/postalsys/Muti-Metroo-Manager/issues/21)
* **proxy:** edge cases in upgrade detection, response headers, streams, downloads ([a2b7c21](https://github.com/postalsys/Muti-Metroo-Manager/commit/a2b7c2107a0e7315dcb18d47f4ba847718ac1924)), closes [#15](https://github.com/postalsys/Muti-Metroo-Manager/issues/15)
* **proxy:** harden WebSocket relay (dial timeout, read limit, ping/pong, close forwarding) ([ef8057a](https://github.com/postalsys/Muti-Metroo-Manager/commit/ef8057af06188ef9a82903ac8e33098d65a19225)), closes [#13](https://github.com/postalsys/Muti-Metroo-Manager/issues/13)
* **proxy:** verify agent TLS by default, add CA bundle and explicit insecure hatch ([55ce4be](https://github.com/postalsys/Muti-Metroo-Manager/commit/55ce4be0ff924dfa69a0bc097d7cb2a6b697aec7)), closes [#11](https://github.com/postalsys/Muti-Metroo-Manager/issues/11)
* **server:** add optional manager auth token, drop wildcard CORS, same-origin WS check ([2838c49](https://github.com/postalsys/Muti-Metroo-Manager/commit/2838c49285c2efe5e8c461cb74e32251f5da3b23)), closes [#9](https://github.com/postalsys/Muti-Metroo-Manager/issues/9)
* **server:** bound metrics method cardinality, dedupe status recorder ([c3b09a6](https://github.com/postalsys/Muti-Metroo-Manager/commit/c3b09a6340ddb217a4c4df1a39e58d571b10dbf4)), closes [#16](https://github.com/postalsys/Muti-Metroo-Manager/issues/16)
* **server:** cap JSON request bodies at 1MB and agent notes at 4096 runes ([e5c0f91](https://github.com/postalsys/Muti-Metroo-Manager/commit/e5c0f91ab79420004bb028b98ff56ede6f4aa93a)), closes [#14](https://github.com/postalsys/Muti-Metroo-Manager/issues/14)
* **server:** graceful shutdown on SIGINT/SIGTERM, no os.Exit in serve goroutine ([1d0ff0f](https://github.com/postalsys/Muti-Metroo-Manager/commit/1d0ff0f2f7c00f9a03a49e08d1ca36522cb7f891)), closes [#12](https://github.com/postalsys/Muti-Metroo-Manager/issues/12)
* **server:** set ReadHeaderTimeout and IdleTimeout on both listeners ([5e7cb2d](https://github.com/postalsys/Muti-Metroo-Manager/commit/5e7cb2d5f6316748e28dbf8ab709464d19b446b6)), closes [#10](https://github.com/postalsys/Muti-Metroo-Manager/issues/10)

## [0.2.39](https://github.com/postalsys/Muti-Metroo-Manager/compare/metroo-manager-v0.2.38...metroo-manager-v0.2.39) (2026-10-11)


### Bug Fixes

* **metrics:** rename Registry.WriteTo to Render ([4498231](https://github.com/postalsys/Muti-Metroo-Manager/commit/4498231bb6b1ea25830aaa274fe1110e66ad1db3))
* **ping:** keep auto-stop timer from killing the next session ([ab97bdc](https://github.com/postalsys/Muti-Metroo-Manager/commit/ab97bdc506596dbb6fbd43b505b2c8f4646be1ae))
* **proxy:** tear down websocket relay when either side disconnects ([e640584](https://github.com/postalsys/Muti-Metroo-Manager/commit/e6405840e0cc4605a9f965fc902a81e49b251432))

## [0.2.38](https://github.com/postalsys/Muti-Metroo-Manager/compare/metroo-manager-v0.2.37...metroo-manager-v0.2.38) (2026-10-10)


### Bug Fixes

* **deps:** resolve frontend npm vulnerabilities ([6ac0bae](https://github.com/postalsys/Muti-Metroo-Manager/commit/6ac0bae94996b50546d702bc8f2f20f2d6aa9595))

## [0.2.37](https://github.com/postalsys/Muti-Metroo-Manager/compare/metroo-manager-v0.2.37...metroo-manager-v0.2.37) (2026-10-10)


### Miscellaneous Chores

* re-release 0.2.37 after repository history migration ([4cb051f](https://github.com/postalsys/Muti-Metroo-Manager/commit/4cb051fd15987e4f559313897d95a6bc26de62ff))
