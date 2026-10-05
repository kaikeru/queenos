/** Read-only load of an Artifacts repo into memory via @cloudflare/shell's git (isomorphic-git over InMemoryFs). */
import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";

export async function loadRepoTree(artifacts: Artifacts, repoName: string, ref = "main") {
  const t0 = Date.now();
  using handle = await artifacts.get(repoName);
  const [{ remote }, { plaintext }] = await Promise.all([handle.info(), handle.createToken("read", 300)]);
  const fs = new InMemoryFs();
  // @cloudflare/shell 0.4.3 bug: createGit's fs adapter does not map mkdir errors to ENOENT, so
  // isomorphic-git's mkdirp cannot create parents ("ENOENT ... mkdir '/repo/.git/hooks'"). Force recursive.
  const gitFs = new Proxy(fs, {
    get(t, k) {
      if (k === "mkdir") return (p: string) => t.mkdir(p, { recursive: true });
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const git = createGit(gitFs, "/repo");
  await git.clone({ url: remote, dir: "/repo", depth: 1, branch: ref, singleBranch: true, username: "x", password: plaintext.split("?expires=")[0] });
  const log = await git.log({ dir: "/repo", depth: 1 }).catch(() => []);
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const name of await fs.readdir(dir)) {
      const p = `${dir}/${name}`;
      if (p === "/repo/.git") continue;
      const st = await fs.stat(p);
      if (st.type === "directory") await walk(p);
      else files[p.slice("/repo/".length)] = await fs.readFile(p);
    }
  };
  await walk("/repo");
  const head = log[0]?.oid ?? null;
  return { files, head, ms: Date.now() - t0 };
}
