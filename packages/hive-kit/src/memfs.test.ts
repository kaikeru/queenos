import { describe, expect, it } from "vitest";
import { MemFS, isFsError, normalizePath } from "./memfs.js";

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe("MemFS", () => {
  it("exposes an enumerable promises property (isomorphic-git requirement)", () => {
    const fs = new MemFS();
    expect(Object.getOwnPropertyDescriptor(fs, "promises")?.enumerable).toBe(true);
    // isomorphic-git probes with readFile() and expects a rejected promise, not a throw.
    const probe = fs.promises.readFile(undefined as unknown as string);
    expect(probe).toBeInstanceOf(Promise);
    expect(fs.promises.rmdir.length).toBe(1);
    return expect(probe).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("normalizes paths", () => {
    expect(normalizePath("//a/./b/../c/")).toBe("/a/c");
    expect(normalizePath("a")).toBe("/a");
  });

  it("reads and writes bytes and utf8", async () => {
    const fs = new MemFS();
    await fs.promises.writeFile("/f.txt", "héllo");
    expect(await fs.promises.readFile("/f.txt", "utf8")).toBe("héllo");
    expect(await fs.promises.readFile("/f.txt", { encoding: "utf8" })).toBe("héllo");
    const bytes = await fs.promises.readFile("/f.txt");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect((await fs.promises.stat("/f.txt")).size).toBe(6);
  });

  it("sets .code on errors", async () => {
    const fs = new MemFS();
    expect(await code(fs.promises.readFile("/missing"))).toBe("ENOENT");
    expect(await code(fs.promises.writeFile("/no/parent/f", "x"))).toBe("ENOENT");
    await fs.promises.mkdir("/d");
    expect(await code(fs.promises.mkdir("/d"))).toBe("EEXIST");
    expect(await code(fs.promises.readFile("/d"))).toBe("EISDIR");
    await fs.promises.writeFile("/d/f", "x");
    expect(await code(fs.promises.rmdir("/d"))).toBe("ENOTEMPTY");
    expect(await code(fs.promises.readdir("/d/f"))).toBe("ENOTDIR");
    expect(await code(fs.promises.stat("/d/f/x"))).toBe("ENOTDIR");
    expect(await code(fs.promises.writeFile("/d/f/x", "y"))).toBe("ENOTDIR");
    expect(await code(fs.promises.unlink("/d"))).toBe("EISDIR");
    expect(await code(fs.promises.unlink("/nope"))).toBe("ENOENT");
    expect(await code(fs.promises.rmdir("/d/f"))).toBe("ENOTDIR");
    try {
      fs.readFileSync("/missing");
    } catch (e) {
      expect(isFsError(e, "ENOENT")).toBe(true);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("mkdir recursive, readdir, rmdir, unlink", async () => {
    const fs = new MemFS();
    await fs.promises.mkdir("/a/b/c", { recursive: true });
    await fs.promises.mkdir("/a/b/c", { recursive: true }); // idempotent
    await fs.promises.writeFile("/a/b/z", "1");
    await fs.promises.writeFile("/a/b/y", "2");
    expect(await fs.promises.readdir("/a/b")).toEqual(["c", "y", "z"]);
    await fs.promises.unlink("/a/b/z");
    await fs.promises.rmdir("/a/b/c");
    expect(await fs.promises.readdir("/a/b")).toEqual(["y"]);
    expect((await fs.promises.stat("/a")).isDirectory()).toBe(true);
    expect((await fs.promises.stat("/a/b/y")).isFile()).toBe(true);
  });

  it("symlinks: lstat vs stat, readlink", async () => {
    const fs = new MemFS();
    await fs.promises.writeFile("/target", "data");
    await fs.promises.symlink("target", "/link");
    expect((await fs.promises.lstat("/link")).isSymbolicLink()).toBe(true);
    expect((await fs.promises.stat("/link")).isFile()).toBe(true);
    expect(await fs.promises.readlink("/link")).toBe("target");
    expect(await fs.promises.readFile("/link", "utf8")).toBe("data");
    expect(await code(fs.promises.symlink("x", "/link"))).toBe("EEXIST");
  });

  it("returns copies so callers cannot mutate stored bytes", async () => {
    const fs = new MemFS();
    await fs.promises.writeFile("/f", new Uint8Array([1, 2, 3]));
    const a = (await fs.promises.readFile("/f")) as Uint8Array;
    a[0] = 9;
    expect(Array.from((await fs.promises.readFile("/f")) as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("walkFiles and writeFileDeep", () => {
    const fs = new MemFS();
    fs.writeFileDeep("/r/x/y.txt", "1");
    fs.writeFileDeep("/r/.git/HEAD", "ref");
    expect(fs.walkFiles("/r", (p) => p.includes("/.git/"))).toEqual(["/r/x/y.txt"]);
  });
});
