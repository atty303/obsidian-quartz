import { minimatch } from "minimatch"
import { QuartzFilterPlugin } from "../types"

export interface Options {
  patterns: string[]
}

export const OnlyPublish: QuartzFilterPlugin<Options> = (opts) => ({
  name: "OnlyPublish",
  shouldPublish(ctx, [_tree, vfile]) {
    const root = ctx.argv.directory
    const path = vfile.path.substring(root.length + 1)
    return (opts?.patterns ?? []).some((pattern) => minimatch(path, pattern));
  },
})
