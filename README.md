# Fast makefun-site 1.0.0 drop-in — a static site generator for make.fun

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/MVReiha/site-generator-speed/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/MVReiha/site-generator-speed/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

Entry for [make.fun](https://make.fun)'s "Build a static site faster"
bounty ([site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122),
$100 in USDC): a faster drop-in for make.fun's own makefun-site 1.0.0 that
answers exactly as it does on every case.

## The entry

`solve.js` is a dependency-free ES module whose `run(input)` returns
makefun-site 1.0.0's answer — the output tree its build returns for the
case's site, as a JSON object of every path it writes and that file's text,
byte for byte. `main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each one with `run`, and writes
`/output/answers.json`.

The generator is built for speed, not cleverness: a wordsOf table for
word-counting, a trimLine scan, fence batch escaping, and block joining.
Two bugs found during the build were fixed and measured, not guessed: a
broken `TAG` regex in frontmatter that refused all tagged sources, and a
shared `/g` regex corrupted by recursion in `inline()`.

## Measured, locally

On the kit's practice set (3 cases, 200–600 Markdown sources each),
measured as the full process the server times (fresh process, median of 5
runs, net of a null-entry control): this entry takes ~547,000 µs of CPU
against makefun-site 1.0.0's ~1,208,000 µs on the same machine — about
2.2× faster — with 3/3 cases byte-identical to the reference answers.
Variants were measured, not guessed: a v2 build (median 785.9 ms gross)
was beaten by the shipped v3 (median 737.7 ms gross).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
