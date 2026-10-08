import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "@babel/parser";

export interface ToolFootprint {
  name: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parametersStr: string;
  totalChars: number;
  estTokens: number;
}

export type ExtensionType =
  | "active-tools"
  | "command-only"
  | "theme-or-library"
  | "directory-not-found";

export interface AnalysisResult {
  pkgName: string;
  pkgDir: string;
  tools: ToolFootprint[];
  commands: string[];
  totalChars: number;
  estTokens: number;
  type: ExtensionType;
}

/** Get the base Pi configuration directory */
export function getPiBaseDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Resolve plugin directory or entry file across environments */
export function resolvePackageDir(input: any, baseDir?: string): string | null {
  const rawInput = typeof input === "object" && input !== null ? input.source || "" : String(input || "");
  if (!rawInput) return null;

  const clean = rawInput.replace(/^(npm:|git:)/, "");

  // Strip trailing ref or version tags (e.g. @1.0.0 or @v1) while preserving scoped names (@scope/name)
  let cleanPkgName = clean;
  if (clean.startsWith("@")) {
    const slashIdx = clean.indexOf("/");
    if (slashIdx !== -1) {
      const scope = clean.slice(0, slashIdx);
      const rest = clean.slice(slashIdx + 1).replace(/@[^/]+$/, "");
      cleanPkgName = `${scope}/${rest}`;
    }
  } else {
    cleanPkgName = clean.replace(/@[^/]+$/, "");
  }

  const piBaseDir = getPiBaseDir();
  const candidates: string[] = [];

  if (baseDir) {
    candidates.push(path.resolve(baseDir, rawInput));
    candidates.push(path.resolve(baseDir, clean));
    candidates.push(path.resolve(baseDir, cleanPkgName));
  }

  candidates.push(
    path.resolve(rawInput),
    path.resolve(clean),
    path.resolve(cleanPkgName),
    path.join(piBaseDir, "npm/node_modules", cleanPkgName),
    path.join(piBaseDir, "npm/node_modules", clean),
    path.join(piBaseDir, "git", cleanPkgName),
    path.join(piBaseDir, "git", clean),
    path.join(piBaseDir, "extensions", cleanPkgName),
    path.join(piBaseDir, "extensions", clean),
    path.join(process.cwd(), "node_modules", cleanPkgName),
    path.join(process.cwd(), ".pi/extensions", cleanPkgName),
  );

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }

  // Fallback: match against installed packages in settings.json (supports short names like 'pi-todo' or 'pi-ask-user-question')
  if (!baseDir) {
    const settingsPaths = [
      path.join(process.cwd(), ".pi", "settings.json"),
      path.join(piBaseDir, "settings.json"),
    ];
    for (const sPath of settingsPaths) {
      if (!fs.existsSync(sPath)) continue;
      try {
        const settings = JSON.parse(fs.readFileSync(sPath, "utf8"));
        const pkgs = settings.packages || [];
        const sDir = path.dirname(sPath);
        for (const p of pkgs) {
          const key = typeof p === "object" && p !== null ? p.source || "" : String(p);
          const normalizedKey = key.replace(/^(npm:|git:)/, "").replace(/@[^/]+$/, "");
          if (
            normalizedKey === cleanPkgName ||
            normalizedKey.endsWith("/" + cleanPkgName) ||
            normalizedKey.split("/").pop() === cleanPkgName
          ) {
            const found = resolvePackageDir(p, sDir);
            if (found) return found;
          }
        }
      } catch {}
    }
  }

  return null;
}

/** Safely evaluate AST nodes statically (literals, template strings, arrays, objects, simple calls, binary concatenation) */
function evalAstNode(node: any, scope = new Map<string, any>(), visited = new Set<any>()): any {
  if (!node || visited.has(node)) return undefined;
  visited.add(node);

  try {
    switch (node.type) {
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
        return node.value;
      case "NullLiteral":
        return null;
      case "TemplateLiteral":
        return node.quasis.map((q: any) => q.value.raw).join("");
      case "BinaryExpression": {
        if (node.operator === "+") {
          const left = evalAstNode(node.left, scope, visited);
          const right = evalAstNode(node.right, scope, visited);
          if (typeof left === "string" || typeof right === "string") {
            return String(left ?? "") + String(right ?? "");
          }
          if (typeof left === "number" && typeof right === "number") {
            return left + right;
          }
        }
        return undefined;
      }
      case "Identifier":
        if (scope.has(node.name)) return evalAstNode(scope.get(node.name), scope, visited);
        return node.name;
      case "ArrayExpression": {
        const arr: any[] = [];
        for (const el of node.elements) {
          if (!el) continue;
          if (el.type === "SpreadElement") {
            const val = evalAstNode(el.argument, scope, visited);
            if (Array.isArray(val)) arr.push(...val);
          } else {
            arr.push(evalAstNode(el, scope, visited));
          }
        }
        return arr;
      }
      case "ObjectExpression": {
        const obj: Record<string, any> = {};
        for (const prop of node.properties) {
          if (prop.type === "ObjectProperty") {
            const key = prop.key.type === "Identifier" ? prop.key.name : evalAstNode(prop.key, scope, visited);
            obj[key] = evalAstNode(prop.value, scope, visited);
          } else if (prop.type === "SpreadElement") {
            const val = evalAstNode(prop.argument, scope, visited);
            if (val && typeof val === "object") Object.assign(obj, val);
          }
        }
        return obj;
      }
      case "CallExpression": {
        let fnName = "";
        if (node.callee.type === "MemberExpression") {
          fnName = (node.callee.object?.name || "") + "." + (node.callee.property?.name || "");
        } else if (node.callee.type === "Identifier") {
          fnName = node.callee.name;
        }
        const args = node.arguments.map((a: any) => evalAstNode(a, scope, visited));
        if (fnName === "Type.String") return { type: "string", ...(args[0] || {}) };
        if (fnName === "Type.Number") return { type: "number", ...(args[0] || {}) };
        if (fnName === "Type.Boolean") return { type: "boolean", ...(args[0] || {}) };
        if (fnName === "Type.Object") return { type: "object", properties: args[0] || {}, ...(args[1] || {}) };
        if (fnName === "Type.Array") return { type: "array", items: args[0], ...(args[1] || {}) };
        if (fnName === "Type.Optional") return { ...(args[0] || {}), optional: true };
        if (fnName === "Type.Record") return { type: "object", ...(args[1] || {}) };
        if (fnName === "StringEnum") return { type: "string", enum: args[0], ...(args[1] || {}) };
        return { type: fnName, args };
      }
      case "TSAsExpression":
      case "TSTypeAssertion":
        return evalAstNode(node.expression, scope, visited);
      default:
        return undefined;
    }
  } finally {
    visited.delete(node);
  }
}

/** Statically analyze a plugin package or directory */
export function analyzePlugin(pkgName: string, pkgDir: string): AnalysisResult {
  const scope = new Map<string, any>();
  const sourceFiles: string[] = [];

  try {
    const stat = fs.statSync(pkgDir);
    if (stat.isFile()) {
      sourceFiles.push(pkgDir);
    } else if (stat.isDirectory()) {
      const scan = (dir: string) => {
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f === "node_modules" || f === ".git" || f === "test" || f === "tests") continue;
            if (f === "dist" && fs.existsSync(path.join(dir, "src"))) continue;
            const full = path.join(dir, f);
            const childStat = fs.statSync(full);
            if (childStat.isDirectory()) {
              scan(full);
            } else if (/\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts")) {
              sourceFiles.push(full);
            }
          }
        } catch {}
      };
      scan(pkgDir);
    }
  } catch {}

  const parsedList: { file: string; ast: any }[] = [];

  // Pass 1: Collect top-level declarations
  for (const f of sourceFiles) {
    try {
      const code = fs.readFileSync(f, "utf8");
      const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
        errorRecovery: true,
      });
      parsedList.push({ file: f, ast });

      for (const node of ast.program.body) {
        let decls: any[] = [];
        if (node.type === "VariableDeclaration") decls = node.declarations;
        else if (node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration") {
          decls = node.declaration.declarations;
        }
        for (const d of decls) {
          if (d.id?.type === "Identifier" && d.init) {
            scope.set(d.id.name, d.init);
          }
        }
      }
    } catch {}
  }

  // Pass 2: Inspect tool and command definitions
  const rawTools: any[] = [];
  const commands: string[] = [];

  for (const { ast } of parsedList) {
    function walk(node: any, parent: any) {
      if (!node || typeof node !== "object") return;

      // Strategy A: Identify tool definition objects (has description + parameters/promptSnippet/promptGuidelines)
      if (node.type === "ObjectExpression") {
        const isArrayMethod =
          parent &&
          parent.type === "CallExpression" &&
          (parent.callee?.property?.name === "push" || parent.callee?.property?.name === "unshift");

        if (!isArrayMethod) {
          const propKeys = new Set(node.properties.map((p: any) => p.key?.name || p.key?.value));
          const hasDesc = propKeys.has("description");
          const hasOther =
            propKeys.has("parameters") || propKeys.has("promptSnippet") || propKeys.has("promptGuidelines");

          if (hasDesc && hasOther) {
            const evaluated = evalAstNode(node, scope);
            if (evaluated && typeof evaluated === "object") {
              if (!evaluated.name) {
                if (parent && parent.type === "CallExpression") {
                  const otherArg = parent.arguments.find((a: any) => a !== node);
                  if (otherArg) {
                    const evalName = evalAstNode(otherArg, scope);
                    if (typeof evalName === "string") evaluated.name = evalName;
                  }
                } else if (parent && parent.type === "VariableDeclarator" && parent.id?.name) {
                  evaluated.name = parent.id.name;
                }
                if (!evaluated.name && evaluated.promptSnippet) {
                  evaluated.name = evaluated.promptSnippet.split(" ")[0].toLowerCase();
                }
              }
              rawTools.push(evaluated);
            }
          }
        }
      }

      // Strategy B: Detect registerCommand
      if (node.type === "CallExpression") {
        const calleeProp = node.callee.type === "MemberExpression" ? node.callee.property.name : "";
        const calleeName = node.callee.type === "Identifier" ? node.callee.name : "";
        if ((calleeProp === "registerCommand" || calleeName === "registerCommand") && node.arguments.length > 0) {
          const nameArg = evalAstNode(node.arguments[0], scope);
          commands.push(typeof nameArg === "string" ? nameArg : "custom-command");
        }
      }

      for (const key of Object.keys(node)) {
        if (key !== "parent") {
          const child = node[key];
          if (Array.isArray(child)) child.forEach((c: any) => walk(c, node));
          else if (child && typeof child === "object") walk(child, node);
        }
      }
    }
    walk(ast.program, null);
  }

  // Deduplicate tools
  const tools: ToolFootprint[] = [];
  const seenNames = new Set<string>();

  for (const t of rawTools) {
    const name = t.name || "unnamed";
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    const desc = typeof t.description === "string" ? t.description : "";
    const snippet = typeof t.promptSnippet === "string" ? t.promptSnippet : "";
    const guidelines = Array.isArray(t.promptGuidelines)
      ? t.promptGuidelines.filter((g: any) => typeof g === "string")
      : typeof t.promptGuidelines === "string"
      ? [t.promptGuidelines]
      : [];
    const schemaStr = t.parameters ? JSON.stringify(t.parameters, null, 2) : "";

    const totalChars = desc.length + snippet.length + guidelines.join("\n").length + schemaStr.length;
    const estTokens = Math.round(totalChars / 3.5);

    tools.push({
      name,
      description: desc,
      promptSnippet: snippet,
      promptGuidelines: guidelines,
      parametersStr: schemaStr,
      totalChars,
      estTokens,
    });
  }

  let totalChars = 0;
  for (const t of tools) totalChars += t.totalChars;
  const estTokens = Math.round(totalChars / 3.5);

  let type: ExtensionType = "active-tools";
  if (tools.length === 0 && commands.length > 0) type = "command-only";
  else if (tools.length === 0) type = "theme-or-library";

  return {
    pkgName,
    pkgDir,
    tools,
    commands: Array.from(new Set(commands)),
    totalChars,
    estTokens,
    type,
  };
}

/** Build leaderboard across configured settings files */
export function buildLeaderboard(): AnalysisResult[] {
  const piBaseDir = getPiBaseDir();
  const settingsPaths = [
    path.join(process.cwd(), ".pi", "settings.json"),
    path.join(piBaseDir, "settings.json"),
  ];

  const packagesMap = new Map<string, { entry: any; baseDir: string }>();

  for (const sPath of settingsPaths) {
    if (!fs.existsSync(sPath)) continue;
    try {
      const settings = JSON.parse(fs.readFileSync(sPath, "utf8"));
      const pkgs = settings.packages || [];
      const sDir = path.dirname(sPath);
      for (const p of pkgs) {
        const key = typeof p === "object" && p !== null ? p.source || JSON.stringify(p) : String(p);
        if (key && !packagesMap.has(key)) {
          packagesMap.set(key, { entry: p, baseDir: sDir });
        }
      }
    } catch {}
  }

  const list: AnalysisResult[] = [];
  for (const [key, { entry, baseDir }] of packagesMap.entries()) {
    const dir = resolvePackageDir(entry, baseDir);
    if (!dir) {
      list.push({
        pkgName: key,
        pkgDir: "",
        tools: [],
        commands: [],
        totalChars: 0,
        estTokens: 0,
        type: "directory-not-found",
      });
      continue;
    }
    list.push(analyzePlugin(key, dir));
  }

  list.sort((a, b) => b.totalChars - a.totalChars);
  return list;
}

/** Format leaderboard as formatted table lines */
export function formatLeaderboard(list: AnalysisResult[]): string[] {
  const lines: string[] = [];
  lines.push("==========================================================================================");
  lines.push("🏆 Installed Pi Extensions Token Footprint Leaderboard");
  lines.push("==========================================================================================");
  lines.push(`  ${"Package Name".padEnd(40)} | ${"Type".padEnd(20)} | Tools | Chars      | Est. Tokens`);
  lines.push("------------------------------------------------------------------------------------------");

  for (const item of list) {
    const nameStr = item.pkgName.length > 38 ? item.pkgName.slice(0, 35) + "..." : item.pkgName;
    const typeStr = item.type;
    const countStr = String(item.tools.length).padStart(4);
    const charsStr = String(item.totalChars.toLocaleString()).padStart(10);
    const tokenStr = item.estTokens > 0 ? `~${item.estTokens.toLocaleString()} tk` : "0 tk";
    lines.push(`  ${nameStr.padEnd(40)} | ${typeStr.padEnd(20)} | ${countStr}  | ${charsStr} | ${tokenStr}`);
  }

  lines.push("==========================================================================================");
  return lines;
}
