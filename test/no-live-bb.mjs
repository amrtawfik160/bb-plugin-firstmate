// Loaded into every test process (`node --test --import ./test/no-live-bb.mjs`). Tests must never
// reach the real BB CLI: on 20 Oct the dev-link test ran a real `bb connect expose 5200` from a
// full run (docs/verification/runtime-fixture-isolation.md has the same cause for other fixtures).
//
// Node gives a child process a socket for stdin. Debian's bash started that way at the top shell
// level (SHLVL absent or 0) takes itself for an ssh login and reads ~/.bashrc, and this host's
// ~/.bashrc puts the real bb ahead of a test's fake one on PATH. A `( … )` around the suite command
// was enough to start the whole run at SHLVL=0. A child bash of a level-1 process is level 2, which
// never reads it. A test that sets SHLVL itself keeps its own value.
const level = Number(process.env.SHLVL);
if (!Number.isInteger(level) || level < 1) process.env.SHLVL = '1';

// An official bb entrypoint re-executes the binary BB_CLI names, wherever PATH points.
delete process.env.BB_CLI;
