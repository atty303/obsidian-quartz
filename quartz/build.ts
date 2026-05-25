import sourceMapSupport from "source-map-support"
import path from "path"
import fs from "fs"
import { PerfTimer } from "./util/perf"
import { rimraf } from "rimraf"
import { GlobbyFilterFunction, isGitIgnored } from "globby"
import chalk from "chalk"
import { MarkdownSource, parseMarkdown, VirtualMarkdownSource } from "./processors/parse"
import { filterContent } from "./processors/filter"
import { emitContent } from "./processors/emit"
import cfg from "../quartz.config"
import { FilePath, FullSlug, joinSegments, slugifyFilePath } from "./util/path"
import chokidar from "chokidar"
import { ProcessedContent } from "./plugins/vfile"
import { Argv, BuildCtx } from "./util/ctx"
import { glob, toPosixPath } from "./util/glob"
import { trace } from "./util/trace"
import { options } from "./util/sourcemap"
import { Mutex } from "async-mutex"
import { getStaticResourcesFromPlugins } from "./plugins"
import { randomIdNonSecure } from "./util/random"
import { ChangeEvent } from "./plugins/types"
import { minimatch } from "minimatch"
import matter from "gray-matter"
import yaml from "js-yaml"
import toml from "toml"

sourceMapSupport.install(options)

type ContentMap = Map<
  FilePath,
  | {
      type: "markdown"
      content: ProcessedContent
    }
  | {
      type: "other"
    }
>

type BuildData = {
  ctx: BuildCtx
  ignored: GlobbyFilterFunction
  mut: Mutex
  contentMap: ContentMap
  articleVirtualsBySource: Map<FilePath, FilePath[]>
  articleVirtualsByPath: Map<FilePath, ArticleVirtualInfo>
  changesSinceLastBuild: Record<FilePath, ChangeEvent["type"]>
  lastBuildMs: number
}

type ArticleVirtualInfo = {
  sourceFilePath: FilePath
  sourceRelativePath: FilePath
  sourceSlug: FullSlug
}

type ArticleVirtualSources = {
  sources: VirtualMarkdownSource[]
  bySource: Map<FilePath, FilePath[]>
  byPath: Map<FilePath, ArticleVirtualInfo>
}

function getRawPublished(data: { [key: string]: unknown }) {
  for (const key of ["published", "publishDate", "date"]) {
    if (data[key] !== undefined && data[key] !== null) {
      return data[key]
    }
  }
}

function parseFrontmatter(src: string) {
  return matter(src, {
    engines: {
      yaml: (s) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as object,
      toml: (s) => toml.parse(s) as object,
    },
  }).data
}

function makeArticleSlug(published: Date, sourceSlug: FullSlug): FullSlug {
  return joinSegments(
    "articles",
    `${published.getFullYear()}-${(published.getMonth() + 1).toString().padStart(2, "0")}`,
    sourceSlug.split("/").pop() ?? "",
  ) as FullSlug
}

function makeArticleVirtualSource(
  argv: Argv,
  sourceRelativePath: FilePath,
  value: string,
  claimedPaths: Set<FilePath>,
): VirtualMarkdownSource | undefined {
  const published = getRawPublished(parseFrontmatter(value))
  if (published === undefined || published === null) return undefined

  const publishedDate = new Date(published as any)
  if (isNaN(publishedDate.getTime())) {
    throw new Error(`Invalid date format for 'published' in file: ${sourceRelativePath}`)
  }

  const sourceSlug = slugifyFilePath(sourceRelativePath)
  const articlesSlug = makeArticleSlug(publishedDate, sourceSlug)
  const relativePath = `${articlesSlug}.md` as FilePath

  if (claimedPaths.has(relativePath)) {
    if (relativePath === sourceRelativePath) return undefined
    throw new Error(
      `Article virtual path \`${relativePath}\` from \`${sourceRelativePath}\` conflicts with an existing file`,
    )
  }

  return {
    kind: "virtual",
    filePath: joinSegments(argv.directory, relativePath) as FilePath,
    relativePath,
    slug: articlesSlug,
    value,
    sourceFilePath: joinSegments(argv.directory, sourceRelativePath) as FilePath,
    sourceRelativePath,
  }
}

async function discoverArticleVirtualSources(
  argv: Argv,
  markdownPaths: FilePath[],
  existingFiles: FilePath[],
): Promise<ArticleVirtualSources> {
  const claimedPaths = new Set(existingFiles)
  const sources: VirtualMarkdownSource[] = []
  const bySource = new Map<FilePath, FilePath[]>()
  const byPath = new Map<FilePath, ArticleVirtualInfo>()

  for (const sourceRelativePath of markdownPaths) {
    const value = await fs.promises.readFile(
      joinSegments(argv.directory, sourceRelativePath),
      "utf8",
    )
    const source = makeArticleVirtualSource(argv, sourceRelativePath, value, claimedPaths)
    if (!source) continue

    claimedPaths.add(source.relativePath)
    sources.push(source)
    bySource.set(source.sourceRelativePath, [source.relativePath])
    byPath.set(source.relativePath, {
      sourceFilePath: source.sourceFilePath,
      sourceRelativePath: source.sourceRelativePath,
      sourceSlug: slugifyFilePath(source.sourceRelativePath),
    })
  }

  return { sources, bySource, byPath }
}

function applyArticleVirtualMetadata(
  content: ProcessedContent[],
  virtualsByPath: Map<FilePath, ArticleVirtualInfo>,
) {
  for (const [_tree, file] of content) {
    const relativePath = file.data.relativePath
    if (!relativePath) continue

    const virtualInfo = virtualsByPath.get(relativePath)
    if (!virtualInfo) continue

    file.data.sourceFilePath = virtualInfo.sourceFilePath
    file.data.sourceRelativePath = virtualInfo.sourceRelativePath
    file.data.aliases = [...new Set([virtualInfo.sourceSlug, ...(file.data.aliases ?? [])])]

    if (file.data.frontmatter) {
      file.data.frontmatter.aliases = [
        ...new Set([virtualInfo.sourceSlug, ...(file.data.frontmatter.aliases ?? [])]),
      ]
    }
  }

  return content
}

async function buildQuartz(argv: Argv, mut: Mutex, clientRefresh: () => void) {
  const ctx: BuildCtx = {
    buildId: randomIdNonSecure(),
    argv,
    cfg,
    allSlugs: [],
    allFiles: [],
    incremental: false,
  }

  const perf = new PerfTimer()
  const output = argv.output

  const pluginCount = Object.values(cfg.plugins).flat().length
  const pluginNames = (key: "transformers" | "filters" | "emitters") =>
    cfg.plugins[key].map((plugin) => plugin.name)
  if (argv.verbose) {
    console.log(`Loaded ${pluginCount} plugins`)
    console.log(`  Transformers: ${pluginNames("transformers").join(", ")}`)
    console.log(`  Filters: ${pluginNames("filters").join(", ")}`)
    console.log(`  Emitters: ${pluginNames("emitters").join(", ")}`)
  }

  const release = await mut.acquire()
  perf.addEvent("clean")
  await rimraf(path.join(output, "*"), { glob: true })
  console.log(`Cleaned output directory \`${output}\` in ${perf.timeSince("clean")}`)

  perf.addEvent("glob")
  const allFiles = await glob("**/*.*", argv.directory, cfg.configuration.ignorePatterns)
  const markdownPaths = allFiles.filter((fp) => fp.endsWith(".md")).sort()
  console.log(
    `Found ${markdownPaths.length} input files from \`${argv.directory}\` in ${perf.timeSince("glob")}`,
  )

  const articleVirtuals = await discoverArticleVirtualSources(argv, markdownPaths, allFiles)
  if (articleVirtuals.sources.length > 0) {
    console.log(`Prepared ${articleVirtuals.sources.length} article virtual files`)
  }

  const filePaths: MarkdownSource[] = [
    ...markdownPaths.map((fp) => joinSegments(argv.directory, fp) as FilePath),
    ...articleVirtuals.sources,
  ]
  ctx.allFiles = [...allFiles, ...articleVirtuals.sources.map((source) => source.relativePath)]
  ctx.allSlugs = ctx.allFiles.map((fp) => slugifyFilePath(fp as FilePath))

  const parsedFiles = applyArticleVirtualMetadata(
    await parseMarkdown(ctx, filePaths),
    articleVirtuals.byPath,
  )
  const filteredContent = filterContent(ctx, parsedFiles)

  await emitContent(ctx, filteredContent)
  console.log(chalk.green(`Done processing ${markdownPaths.length} files in ${perf.timeSince()}`))
  release()

  if (argv.watch) {
    ctx.incremental = true
    return startWatching(ctx, mut, parsedFiles, clientRefresh, articleVirtuals)
  }
}

// setup watcher for rebuilds
async function startWatching(
  ctx: BuildCtx,
  mut: Mutex,
  initialContent: ProcessedContent[],
  clientRefresh: () => void,
  articleVirtuals: ArticleVirtualSources,
) {
  const { argv, allFiles } = ctx

  const contentMap: ContentMap = new Map()
  for (const filePath of allFiles) {
    contentMap.set(filePath, {
      type: "other",
    })
  }

  for (const content of initialContent) {
    const [_tree, vfile] = content
    contentMap.set(vfile.data.relativePath!, {
      type: "markdown",
      content,
    })
  }

  const gitIgnoredMatcher = await isGitIgnored()
  const buildData: BuildData = {
    ctx,
    mut,
    contentMap,
    articleVirtualsBySource: articleVirtuals.bySource,
    articleVirtualsByPath: articleVirtuals.byPath,
    ignored: (path) => {
      if (gitIgnoredMatcher(path)) return true
      const pathStr = path.toString()
      for (const pattern of cfg.configuration.ignorePatterns) {
        if (minimatch(pathStr, pattern)) {
          return true
        }
      }

      return false
    },

    changesSinceLastBuild: {},
    lastBuildMs: 0,
  }

  const watcher = chokidar.watch(".", {
    persistent: true,
    cwd: argv.directory,
    ignoreInitial: true,
  })

  const changes: ChangeEvent[] = []
  watcher
    .on("add", (fp) => {
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "add" })
      void rebuild(changes, clientRefresh, buildData)
    })
    .on("change", (fp) => {
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "change" })
      void rebuild(changes, clientRefresh, buildData)
    })
    .on("unlink", (fp) => {
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "delete" })
      void rebuild(changes, clientRefresh, buildData)
    })

  return async () => {
    await watcher.close()
  }
}

async function rebuild(changes: ChangeEvent[], clientRefresh: () => void, buildData: BuildData) {
  const {
    ctx,
    contentMap,
    mut,
    changesSinceLastBuild,
    articleVirtualsBySource,
    articleVirtualsByPath,
  } = buildData
  const { argv, cfg } = ctx

  const buildId = randomIdNonSecure()
  ctx.buildId = buildId
  buildData.lastBuildMs = new Date().getTime()
  const numChangesInBuild = changes.length
  const release = await mut.acquire()

  // if there's another build after us, release and let them do it
  if (ctx.buildId !== buildId) {
    release()
    return
  }

  const perf = new PerfTimer()
  perf.addEvent("rebuild")
  console.log(chalk.yellow("Detected change, rebuilding..."))

  // update changesSinceLastBuild
  for (const change of changes) {
    changesSinceLastBuild[change.path] = change.type
  }

  const changesForBuild: Record<FilePath, ChangeEvent["type"]> = { ...changesSinceLastBuild }
  for (const fp of Object.keys(changesForBuild)) {
    delete changesSinceLastBuild[fp as FilePath]
  }

  const pathsToParse: MarkdownSource[] = []
  for (const [fp, type] of Object.entries(changesForBuild)) {
    const relativePath = fp as FilePath
    if (type === "delete") {
      contentMap.delete(relativePath)
      continue
    }

    if (path.extname(fp) !== ".md") {
      contentMap.set(relativePath, { type: "other" })
      continue
    }

    if (!contentMap.has(relativePath)) {
      contentMap.set(relativePath, { type: "other" })
    }

    const fullPath = joinSegments(argv.directory, toPosixPath(fp)) as FilePath
    pathsToParse.push(fullPath)
  }

  for (const [fp, type] of Object.entries(changesForBuild)) {
    const sourceRelativePath = fp as FilePath
    if (path.extname(fp) !== ".md") continue

    const staleVirtuals = new Set(articleVirtualsBySource.get(sourceRelativePath) ?? [])
    articleVirtualsBySource.delete(sourceRelativePath)

    if (type !== "delete") {
      const fullPath = joinSegments(argv.directory, toPosixPath(fp)) as FilePath
      const value = await fs.promises.readFile(fullPath, "utf8")
      const claimedPaths = new Set(contentMap.keys())
      for (const staleVirtual of staleVirtuals) {
        claimedPaths.delete(staleVirtual)
      }

      const virtualSource = makeArticleVirtualSource(argv, sourceRelativePath, value, claimedPaths)

      if (virtualSource) {
        const changeType = staleVirtuals.has(virtualSource.relativePath) ? "change" : "add"
        staleVirtuals.delete(virtualSource.relativePath)
        pathsToParse.push(virtualSource)
        contentMap.set(virtualSource.relativePath, { type: "other" })
        changesForBuild[virtualSource.relativePath] = changeType
        articleVirtualsBySource.set(sourceRelativePath, [virtualSource.relativePath])
        articleVirtualsByPath.set(virtualSource.relativePath, {
          sourceFilePath: virtualSource.sourceFilePath,
          sourceRelativePath: virtualSource.sourceRelativePath,
          sourceSlug: slugifyFilePath(virtualSource.sourceRelativePath),
        })
      }
    }

    for (const staleVirtual of staleVirtuals) {
      contentMap.delete(staleVirtual)
      changesForBuild[staleVirtual] = "delete"
      articleVirtualsByPath.delete(staleVirtual)
    }
  }

  // Make new article slugs visible to link-resolution plugins before parsing changed files.
  ctx.allFiles = Array.from(contentMap.keys())
  ctx.allSlugs = ctx.allFiles.map((fp) => slugifyFilePath(fp as FilePath))

  const staticResources = getStaticResourcesFromPlugins(ctx)
  const parsed = applyArticleVirtualMetadata(
    await parseMarkdown(ctx, pathsToParse),
    articleVirtualsByPath,
  )
  for (const content of parsed) {
    contentMap.set(content[1].data.relativePath!, {
      type: "markdown",
      content,
    })
  }

  // update state using changesSinceLastBuild
  // we do this weird play of add => compute change events => remove
  // so that partialEmitters can do appropriate cleanup based on the content of deleted files
  for (const [file, change] of Object.entries(changesForBuild)) {
    if (change === "delete") {
      // universal delete case
      contentMap.delete(file as FilePath)
    }
  }

  const changeEvents: ChangeEvent[] = Object.entries(changesForBuild).map(([fp, type]) => {
    const path = fp as FilePath
    const processedContent = contentMap.get(path)
    if (processedContent?.type === "markdown") {
      const [_tree, file] = processedContent.content
      return {
        type,
        path,
        file,
      }
    }

    return {
      type,
      path,
    }
  })

  // update allFiles and then allSlugs with the consistent view of content map
  ctx.allFiles = Array.from(contentMap.keys())
  ctx.allSlugs = ctx.allFiles.map((fp) => slugifyFilePath(fp as FilePath))
  let processedFiles = Array.from(contentMap.values())
    .filter((file) => file.type === "markdown")
    .map((file) => file.content)

  let emittedFiles = 0
  for (const emitter of cfg.plugins.emitters) {
    // Try to use partialEmit if available, otherwise assume the output is static
    const emitFn = emitter.partialEmit ?? emitter.emit
    const emitted = await emitFn(ctx, processedFiles, staticResources, changeEvents)
    if (emitted === null) {
      continue
    }

    if (Symbol.asyncIterator in emitted) {
      // Async generator case
      for await (const file of emitted) {
        emittedFiles++
        if (ctx.argv.verbose) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    } else {
      // Array case
      emittedFiles += emitted.length
      if (ctx.argv.verbose) {
        for (const file of emitted) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    }
  }

  console.log(`Emitted ${emittedFiles} files to \`${argv.output}\` in ${perf.timeSince("rebuild")}`)
  console.log(chalk.green(`Done rebuilding in ${perf.timeSince()}`))
  changes.splice(0, numChangesInBuild)
  clientRefresh()
  release()
}

export default async (argv: Argv, mut: Mutex, clientRefresh: () => void) => {
  try {
    return await buildQuartz(argv, mut, clientRefresh)
  } catch (err) {
    trace("\nExiting Quartz due to a fatal error", err as Error)
  }
}
