import { QuartzTransformerPlugin } from "../types"
import { FilePath, FullSlug, joinSegments } from "../../util/path"
import { Data, VFile } from "vfile"
import { ProcessedContent } from "../vfile"
import { BuildCtx } from "../../util/ctx"

export interface Options {
  mapFn: (published: Date, data: Data) => FullSlug | undefined
}

const defaultOptions: Options = {
  mapFn: (published, data) =>
    `articles/${published.getFullYear()}-${(published.getMonth() + 1).toString().padStart(2, "0")}/${data.slug}` as FullSlug,
}

export const Articles: QuartzTransformerPlugin<Partial<Options>> = (userOpts) => {
  const opts = { ...defaultOptions, ...userOpts }
  return {
    name: "Articles",
    contentTransform(ctx: BuildCtx, content: ProcessedContent[]): ProcessedContent[] {
      const virtual = content.flatMap(([tree, file]) => {
        if ((file.data as any).sourceRelativePath) return []

        const published = file.data.frontmatter?.published
        if (!published) return []

        const publishedDate = new Date(published)
        if (isNaN(publishedDate.getTime())) {
          throw new Error(`Invalid date format for 'published' in file: ${file.data.slug}`)
        }

        const articlesSlug = opts.mapFn(publishedDate, file.data)
        if (!articlesSlug) return []

        const vf = new VFile(file.value)
        vf.path = joinSegments(ctx.argv.directory, articlesSlug + ".md")
        vf.data = {
          ...file.data,
          slug: articlesSlug,
          relativePath: (articlesSlug + ".md") as FilePath,
          filePath: joinSegments(ctx.argv.directory, articlesSlug + ".md") as FilePath,
          sourceRelativePath: file.data.relativePath,
          frontmatter: {
            ...file.data.frontmatter,
            title: file.data.frontmatter?.title ?? "",
            aliases: [file.data.slug!, ...(file.data.frontmatter?.aliases ?? [])],
          },
        }
        ctx.allSlugs.push(articlesSlug)
        return [[tree, vf] as ProcessedContent]
      })
      return [...content, ...virtual]
    },
  }
}
