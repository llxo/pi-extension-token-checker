import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "@babel/parser";

export type ToolStatus = "active" | "on-demand" | "conditional";

export interface ToolFootprint {
  name: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parametersStr: string;
  totalChars: number;
  estTokens: number;
  status: ToolStatus;
  conditionDesc?: string;
}

export interface PromptInjection {
  event: string;
  description: string;
  content: string;
  chars: number;
  estTokens: number;
}

export type ExtensionType =
  | "active-tools"
  | "on-demand-tools"
  | "builtin-override"
  | "prompt-inject"
  | "command-only"
  | "theme-or-library"
  | "directory-not-found";

export interface AnalysisResult {
  pkgName: string;
  pkgDir: string;
  tools: ToolFootprint[];
  commands: string[];
  promptInjections: PromptInjection[];
  totalChars: number;
  estTokens: number;
  activeTokens: number;
  type: ExtensionType;
}

const BUILTIN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/** Accurately estimate tokens considering CJK vs Latin/code characters */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs, Symbols & Punctuation, Fullwidth Forms
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  // 1 CJK char ≈ 1.3 tokens; 1 English/code char ≈ 0.28 tokens (1 token ≈ 3.6 chars)
  const est = Math.round(cjkCount * 1.3 + otherCount / 3.6);
  return Math.max(1, est);
}

/** Get the base Pi configuration directory */
export function getPiBaseDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Built-in standard parameter schemas for Pi built-in tool factories */
const BUILTIN_FACTORY_SCHEMAS: Record<string, any> = {
  createReadToolDefinition: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to file to read" },
      offset: { type: "number", description: "Start line number (1-based)" },
      limit: { type: "number", description: "Maximum lines to read" },
    },
    required: ["path"],
  },
  createWriteToolDefinition: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to file to write" },
      content: { type: "string", description: "Content to write to file" },
    },
    required: ["path", "content"],
  },
  createEditToolDefinition: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to file to edit" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Text to replace" },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  createBashToolDefinition: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      timeout: { type: "number", description: "Optional timeout in seconds" },
    },
    required: ["command"],
  },
};

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

  // Fallback: match against installed packages in settings.json
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

/** Safely evaluate AST nodes statically */
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
      case "TemplateLiteral": {
        let res = "";
        for (let i = 0; i < node.quasis.length; i++) {
          res += node.quasis[i].value.raw;
          if (i < node.expressions.length) {
            const val = evalAstNode(node.expressions[i], scope, visited);
            res += val !== undefined ? String(val) : "";
          }
        }
        return res;
      }
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
      case "MemberExpression": {
        const obj = evalAstNode(node.object, scope, visited);
        const propName =
          node.property.type === "Identifier" ? node.property.name : evalAstNode(node.property, scope, visited);
        if (obj && typeof obj === "object" && propName && propName in obj) {
          return obj[propName];
        }
        if (typeof propName === "string") return propName;
        return undefined;
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression": {
        const fnScope = new Map(scope);
        for (const p of node.params) {
          if (p.type === "Identifier") {
            fnScope.set(p.name, {
              grep: "ffgrep",
              find: "fffind",
              multiGrep: "fff-multi-grep",
              [p.name]: p.name,
            });
          }
        }
        if (node.body.type !== "BlockStatement") {
          return evalAstNode(node.body, fnScope, visited);
        }
        for (const stmt of node.body.body) {
          if (stmt.type === "ReturnStatement" && stmt.argument) {
            return evalAstNode(stmt.argument, fnScope, visited);
          }
        }
        return undefined;
      }
      case "CallExpression": {
        let fnName = "";
        if (node.callee.type === "MemberExpression") {
          fnName = (node.callee.object?.name || "") + "." + (node.callee.property?.name || "");
        } else if (node.callee.type === "Identifier") {
          fnName = node.callee.name;
        }

        // Built-in tool definition factories
        for (const [factoryName, schema] of Object.entries(BUILTIN_FACTORY_SCHEMAS)) {
          if (fnName.includes(factoryName)) {
            return { parameters: schema };
          }
        }

        const args = node.arguments.map((a: any) => evalAstNode(a, scope, visited));
        if (fnName === "Type.String") return { type: "string", ...(args[0] || {}) };
        if (fnName === "Type.Number") return { type: "number", ...(args[0] || {}) };
        if (fnName === "Type.Integer") return { type: "integer", ...(args[0] || {}) };
        if (fnName === "Type.Boolean") return { type: "boolean", ...(args[0] || {}) };
        if (fnName === "Type.Object") return { type: "object", properties: args[0] || {}, ...(args[1] || {}) };
        if (fnName === "Type.Array") return { type: "array", items: args[0], ...(args[1] || {}) };
        if (fnName === "Type.Optional") return { ...(args[0] || {}), optional: true };
        if (fnName === "Type.Union") return { anyOf: Array.isArray(args[0]) ? args[0] : [args[0]], ...(args[1] || {}) };
        if (fnName === "Type.Intersect") return { allOf: Array.isArray(args[0]) ? args[0] : [args[0]], ...(args[1] || {}) };
        if (fnName === "Type.Record") return { type: "object", ...(args[1] || {}) };
        if (fnName === "Type.Literal") return { const: args[0], ...(args[1] || {}) };
        if (fnName === "StringEnum") return { type: "string", enum: args[0], ...(args[1] || {}) };
        if (node.callee.type === "ArrowFunctionExpression" || node.callee.type === "FunctionExpression") {
          return evalAstNode(node.callee, scope, visited);
        }
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

  // Pass 1: Recursively collect variable declarations across all scopes
  for (const f of sourceFiles) {
    try {
      const code = fs.readFileSync(f, "utf8");
      const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
        errorRecovery: true,
      });
      parsedList.push({ file: f, ast });

      const collectDecls = (node: any) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "VariableDeclaration") {
          for (const d of node.declarations) {
            if (d.id?.type === "Identifier" && d.init) {
              if (!scope.has(d.id.name)) {
                scope.set(d.id.name, d.init);
              }
            }
          }
        }
        for (const key of Object.keys(node)) {
          if (key === "parent") continue;
          const child = node[key];
          if (Array.isArray(child)) child.forEach(collectDecls);
          else if (child && typeof child === "object") collectDecls(child);
        }
      };
      collectDecls(ast.program);
    } catch {}
  }

  // Pre-seed common tool name references in scope if missing
  if (!scope.has("toolNames")) {
    scope.set("toolNames", { grep: "ffgrep", find: "fffind", multiGrep: "fff-multi-grep" });
  }

  // Check whether session_start explicitly unloads tools (e.g. pi-ssh-tools)
  let sessionStartUnloadsTools = false;
  for (const { ast } of parsedList) {
    const checkSessionStart = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.property?.name === "on" &&
        node.arguments?.[0]?.value === "session_start"
      ) {
        const cb = node.arguments[1];
        const walkCb = (n: any) => {
          if (!n || typeof n !== "object") return;
          if (n.type === "CallExpression") {
            const name = n.callee.name || n.callee.property?.name || "";
            if (name.toLowerCase().includes("disable") || name === "setActiveTools") {
              sessionStartUnloadsTools = true;
            }
          }
          for (const k of Object.keys(n)) {
            if (k !== "parent") {
              const c = n[k];
              if (Array.isArray(c)) c.forEach(walkCb);
              else if (c && typeof c === "object") walkCb(c);
            }
          }
        };
        walkCb(cb);
      }
      for (const key of Object.keys(node)) {
        if (key !== "parent") {
          const child = node[key];
          if (Array.isArray(child)) child.forEach(checkSessionStart);
          else if (child && typeof child === "object") checkSessionStart(child);
        }
      }
    };
    checkSessionStart(ast.program);
  }

  // Pass 2: Inspect tool and command definitions and prompt injections
  const rawTools: any[] = [];
  const commands: string[] = [];
  const promptInjections: PromptInjection[] = [];

  for (const { ast } of parsedList) {
    function walk(node: any, parent: any, currentCondition?: string) {
      if (!node || typeof node !== "object") return;

      // Track conditional blocks
      let nextCondition = currentCondition;
      if (node.type === "IfStatement" && node.test) {
        if (node.test.type === "Identifier") {
          nextCondition = node.test.name;
        } else if (node.test.type === "BinaryExpression") {
          const l = evalAstNode(node.test.left, scope) ?? "expr";
          const r = evalAstNode(node.test.right, scope) ?? "val";
          nextCondition = `${l} ${node.test.operator} ${r}`;
        } else if (node.test.type === "CallExpression") {
          const fn = node.test.callee.name || node.test.callee.property?.name || "condition";
          const firstArg = evalAstNode(node.test.arguments[0], scope) ?? "";
          nextCondition = `${fn}(${firstArg})`;
        } else {
          nextCondition = "conditional";
        }
      }

      // Detect before_agent_start prompt injections
      if (
        node.type === "CallExpression" &&
        node.callee?.property?.name === "on" &&
        node.arguments?.[0]?.value === "before_agent_start"
      ) {
        const cb = node.arguments[1];
        let foundPromptText = "";

        const inspectPromptHook = (n: any) => {
          if (!n || typeof n !== "object") return;
          if (n.type === "Identifier" && scope.has(n.name)) {
            const val = evalAstNode(scope.get(n.name), scope);
            if (typeof val === "string" && val.length > 30) {
              foundPromptText = val;
            }
          } else if (n.type === "StringLiteral" && n.value.length > 30) {
            foundPromptText = n.value;
          } else if (n.type === "TemplateLiteral") {
            const text = evalAstNode(n, scope);
            if (typeof text === "string" && text.length > 30) {
              foundPromptText = text;
            }
          }
          for (const k of Object.keys(n)) {
            if (k !== "parent") {
              const c = n[k];
              if (Array.isArray(c)) c.forEach(inspectPromptHook);
              else if (c && typeof c === "object") inspectPromptHook(c);
            }
          }
        };
        inspectPromptHook(cb);

        if (foundPromptText) {
          const chars = foundPromptText.length;
          const tokens = estimateTokens(foundPromptText);
          promptInjections.push({
            event: "before_agent_start",
            description: "Dynamic system prompt injection",
            content: foundPromptText,
            chars,
            estTokens: tokens,
          });
        }
      }

      // Strategy A: Identify tool definition objects
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

              // Status classification:
              // 1. If plugin unloads tools on session_start => on-demand
              // 2. If condition requires explicit opt-in (e.g. === "1") => conditional
              // 3. Otherwise (including default-enabled flags like isExtraToolEnabled) => active
              if (sessionStartUnloadsTools) {
                evaluated.status = "on-demand";
              } else if (currentCondition && (currentCondition.includes("=== \"1\"") || currentCondition.includes("== 1"))) {
                evaluated.status = "conditional";
                evaluated.conditionDesc = currentCondition;
              } else {
                evaluated.status = "active";
                if (currentCondition) evaluated.conditionDesc = currentCondition;
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
          if (Array.isArray(child)) child.forEach((c: any) => walk(c, node, nextCondition));
          else if (child && typeof child === "object") walk(child, node, nextCondition);
        }
      }
    }
    walk(ast.program, null, undefined);
  }

  // Deduplicate and process tools
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

    let schemaObj = t.parameters;
    if (typeof schemaObj === "string" && scope.has(schemaObj)) {
      schemaObj = evalAstNode(scope.get(schemaObj), scope);
    }
    const schemaStr = schemaObj ? JSON.stringify(schemaObj, null, 2) : "";

    const fullPromptText = [desc, snippet, ...guidelines, schemaStr].filter(Boolean).join("\n");
    const totalChars = fullPromptText.length;
    const estTokens = estimateTokens(fullPromptText);

    tools.push({
      name,
      description: desc,
      promptSnippet: snippet,
      promptGuidelines: guidelines,
      parametersStr: schemaStr,
      totalChars,
      estTokens,
      status: t.status || "active",
      conditionDesc: t.conditionDesc,
    });
  }

  // Check if extension only overrides built-in tools (like foldable-tools)
  const isBuiltinOverride =
    tools.length > 0 && tools.every((t) => BUILTIN_TOOL_NAMES.has(t.name) || t.name === "name");

  // Calculate totals
  let totalChars = 0;
  let estTokens = 0;
  let activeTokens = 0;

  if (!isBuiltinOverride) {
    for (const t of tools) {
      totalChars += t.totalChars;
      estTokens += t.estTokens;
      if (t.status === "active") {
        activeTokens += t.estTokens;
      }
    }
  }

  for (const inj of promptInjections) {
    totalChars += inj.chars;
    estTokens += inj.estTokens;
    activeTokens += inj.estTokens;
  }

  // Determine overall extension type
  let type: ExtensionType = "active-tools";
  const hasActiveTools = tools.some((t) => t.status === "active");
  const hasOnDemandTools = tools.some((t) => t.status === "on-demand");

  if (isBuiltinOverride) {
    type = "builtin-override";
  } else if (hasActiveTools) {
    type = "active-tools";
  } else if (hasOnDemandTools) {
    type = "on-demand-tools";
  } else if (promptInjections.length > 0) {
    type = "prompt-inject";
  } else if (commands.length > 0) {
    type = "command-only";
  } else {
    type = "theme-or-library";
  }

  return {
    pkgName,
    pkgDir,
    tools,
    commands: Array.from(new Set(commands)),
    promptInjections,
    totalChars,
    estTokens,
    activeTokens,
    type,
  };
}

/** Build leaderboard across configured settings files and local extensions directories */
export function buildLeaderboard(): AnalysisResult[] {
  const piBaseDir = getPiBaseDir();
  const settingsPaths = [
    path.join(process.cwd(), ".pi", "settings.json"),
    path.join(piBaseDir, "settings.json"),
  ];

  const packagesMap = new Map<string, { entry: any; baseDir: string }>();

  // 1. Scan packages in settings.json
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

  // 2. Scan local user extensions in ~/.pi/agent/extensions/
  const localExtensionDirs = [
    path.join(piBaseDir, "extensions"),
    path.join(process.cwd(), ".pi", "extensions"),
  ];

  for (const extDir of localExtensionDirs) {
    if (!fs.existsSync(extDir)) continue;
    try {
      const entries = fs.readdirSync(extDir);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        // Filter out non-script files or backup files
        const fullPath = path.join(extDir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isFile() && !/\.(ts|js|mjs)$/.test(entry)) continue;

        // Skip duplicates already covered by npm/git packages
        let alreadyTracked = false;
        const normalizedEntry = entry.replace(/\.(ts|js|mjs)$/, "");
        for (const existingKey of packagesMap.keys()) {
          const cleanKey = existingKey.replace(/^(npm:|git:)/, "").replace(/@[^/]+$/, "");
          if (cleanKey.endsWith("/" + normalizedEntry) || cleanKey === normalizedEntry) {
            alreadyTracked = true;
            break;
          }
        }

        const name = `local:${entry}`;
        if (!alreadyTracked && !packagesMap.has(name)) {
          packagesMap.set(name, { entry: fullPath, baseDir: extDir });
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
        promptInjections: [],
        totalChars: 0,
        estTokens: 0,
        activeTokens: 0,
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
  lines.push("==========================================================================================================");
  lines.push("🏆 Installed Pi Extensions Token Footprint Leaderboard");
  lines.push("==========================================================================================================");
  lines.push(`  ${"Package Name".padEnd(38)} | ${"Type".padEnd(16)} | Tools | Chars      | Est. Tokens`);
  lines.push("----------------------------------------------------------------------------------------------------------");

  for (const item of list) {
    const nameStr = item.pkgName.length > 36 ? item.pkgName.slice(0, 33) + "..." : item.pkgName;
    const typeStr = item.type;
    const countStr = String(item.tools.length).padStart(4);
    const charsStr = String(item.totalChars.toLocaleString()).padStart(10);

    let tokenStr = "0 tk";
    if (item.type === "on-demand-tools") {
      tokenStr = `~${item.estTokens.toLocaleString()} tk (on-demand)`;
    } else if (item.type === "prompt-inject") {
      tokenStr = `~${item.estTokens.toLocaleString()} tk (inject)`;
    } else if (item.type === "builtin-override") {
      tokenStr = "0 tk (override)";
    } else if (item.estTokens > 0) {
      if (item.activeTokens < item.estTokens && item.activeTokens > 0) {
        tokenStr = `~${item.activeTokens.toLocaleString()} tk (~${item.estTokens} max)`;
      } else {
        tokenStr = `~${item.estTokens.toLocaleString()} tk`;
      }
    }

    lines.push(`  ${nameStr.padEnd(38)} | ${typeStr.padEnd(16)} | ${countStr}  | ${charsStr} | ${tokenStr}`);
  }

  lines.push("==========================================================================================================");
  return lines;
}
