#!/usr/bin/env bun
import { runCli } from "../src/cli"
import { configureSidecarRg } from "../src/sidecars"

configureSidecarRg(process.env, process.execPath)
process.exitCode = await runCli()
