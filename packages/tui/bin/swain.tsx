#!/usr/bin/env bun
import { runCli } from "../src/cli"

process.exitCode = await runCli()
