import { minimatch } from "minimatch"
import { QuartzFilterPlugin } from "../types"

export interface Options {
  patterns: string[]
}

export const OnlyPublish: QuartzFilterPlugin<Options> = (opts) => ({
  name: "OnlyPublish",
  shouldPublish(_ctx, [_tree, vfile]) {
    const path = vfile.data.relativePath ?? ""
    const slug = vfile.data.slug ?? ""
    return (opts?.patterns ?? []).some((pattern) => minimatch(path, pattern) || minimatch(slug, pattern))
  },
})
