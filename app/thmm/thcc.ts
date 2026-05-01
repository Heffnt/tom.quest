/**
 * THCC — TypeScript port of the Haskell compiler in
 * THMM_THCC/THMM/THCC/{Parser,AST,CodeGen,THMM}.hs.
 *
 * Pipeline matches the reference implementation:
 *
 *   parseProgram → genProgram → link → encode
 *
 * The one extension over the Haskell version is source-position tracking:
 * every AST node carries a {start, end} character span, every emitted
 * instruction records the AST node it came from, and the linker propagates
 * that span onto the final 16-bit machine instruction. The visualizer uses
 * the spans to highlight source ↔ instruction correspondences.
 *
 * Grammar (identical to Parser.hs):
 *
 *   program   ::= statement*
 *   statement ::= "int" IDENT ("=" expr)? ";"
 *   expr      ::= term   (("+" | "-") term)*
 *   term      ::= factor (("*" | "/") factor)*
 *   factor    ::= NUMBER | IDENT | "(" expr ")"
 */

// ==========================================================================
// Types
// ==========================================================================

export type Span = { start: number; end: number };

export type Op = "add" | "sub" | "mul" | "div";

export type Expr =
  | { kind: "lit"; value: number; span: Span }
  | { kind: "var"; name: string; span: Span }
  | { kind: "binop"; op: Op; left: Expr; right: Expr; span: Span };

export type Stmt =
  | { kind: "decl"; name: string; expr: Expr; span: Span }
  | { kind: "declEmpty"; name: string; span: Span };

export type Program = Stmt[];

/** Symbolic operand: pre-link, addresses are still labels. */
export type Addr =
  | { kind: "imm"; value: number }
  | { kind: "var"; name: string }
  | { kind: "tmp"; idx: number };

export type Mnemonic =
  | "loadm" | "loadn" | "store"
  | "addm" | "addn" | "subm" | "mulm" | "divm" | "halt";

export type SymInst = {
  op: Mnemonic;
  addr: Addr | null;       // null only for halt
  span: Span;              // origin AST node
};

/** Final, address-resolved instruction the simulator can ingest. */
export type ThmmInst = {
  op: Mnemonic;
  arg: number;             // 0 for halt
  bits: string;            // 16 chars
  hex: string;             // 4 chars
  asm: string;             // mnemonic + operand
  span: Span;              // source span (for highlighting)
};

export type VarBinding = {
  name: string;
  addr: number;
  span: Span;              // declaration span
};

export type CompileError =
  | { kind: "parse"; offset: number; line: number; col: number; message: string }
  | { kind: "undefinedVar"; name: string; span: Span }
  | { kind: "duplicateDecl"; name: string; span: Span }
  | { kind: "literalOutOfRange"; n: number; span: Span }
  | { kind: "programTooLarge"; used: number; capacity: number };

/**
 * Successful compile exposes every intermediate stage so the visualizer can
 * scrub through them. `symInsts` is the pre-link form (addresses still as
 * labels); `instructions` is the same list after the linker has resolved
 * each label to a concrete RAM address.
 */
export type CompileResult =
  | {
      ok: true;
      ast: Program;
      symInsts: SymInst[];
      maxTemps: number;
      instructions: ThmmInst[];
      varMap: VarBinding[];
    }
  | { ok: false; error: CompileError };

// ==========================================================================
// 1. Parser — hand-rolled recursive descent (replaces Megaparsec)
// ==========================================================================
//
// The parser is deliberately small and direct: a single index walks the
// source, lex helpers eat whitespace + line comments after every token, and
// expression precedence is encoded in two mutually recursive routines
// (expression handles + / -, term handles * / /).

const RESERVED = new Set(["int"]);

class Parser {
  src: string;
  pos: number = 0;

  constructor(src: string) { this.src = src; }

  // -- low-level character helpers ----------------------------------------

  peek(off = 0): string { return this.src[this.pos + off] ?? ""; }
  atEnd(): boolean { return this.pos >= this.src.length; }

  ws(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.pos++;
      } else if (c === "/" && this.peek(1) === "/") {
        while (!this.atEnd() && this.peek() !== "\n") this.pos++;
      } else {
        break;
      }
    }
  }

  fail(message: string): never {
    throw new ParseFailure(this.pos, message);
  }

  // -- token-level parsers (each consumes trailing whitespace) ------------

  symbol(s: string): void {
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length;
      this.ws();
    } else {
      this.fail(`expected '${s}'`);
    }
  }

  /** Reserved word: must not be followed by an identifier character. */
  keyword(kw: string): void {
    if (
      this.src.startsWith(kw, this.pos) &&
      !isIdentRest(this.peek(kw.length))
    ) {
      this.pos += kw.length;
      this.ws();
    } else {
      this.fail(`expected keyword '${kw}'`);
    }
  }

  identifier(): { name: string; span: Span } {
    const start = this.pos;
    if (!isIdentStart(this.peek())) this.fail("expected identifier");
    while (isIdentRest(this.peek())) this.pos++;
    const name = this.src.slice(start, this.pos);
    if (RESERVED.has(name)) this.fail(`unexpected reserved word '${name}'`);
    const span = { start, end: this.pos };
    this.ws();
    return { name, span };
  }

  integer(): { value: number; span: Span } {
    const start = this.pos;
    if (!isDigit(this.peek())) this.fail("expected integer literal");
    while (isDigit(this.peek())) this.pos++;
    const value = Number(this.src.slice(start, this.pos));
    const span = { start, end: this.pos };
    this.ws();
    return { value, span };
  }

  // -- grammar ------------------------------------------------------------

  parseProgram(): Program {
    this.ws();
    const stmts: Stmt[] = [];
    while (!this.atEnd()) stmts.push(this.parseStmt());
    return stmts;
  }

  parseStmt(): Stmt {
    const start = this.pos;
    this.keyword("int");
    const id = this.identifier();
    if (this.peek() === "=") {
      this.symbol("=");
      const expr = this.parseExpr();
      this.symbol(";");
      return { kind: "decl", name: id.name, expr, span: { start, end: this.pos } };
    }
    this.symbol(";");
    return { kind: "declEmpty", name: id.name, span: { start, end: this.pos } };
  }

  /** expr ::= term (("+" | "-") term)*   — left associative */
  parseExpr(): Expr {
    const start = this.pos;
    let left = this.parseTerm();
    for (;;) {
      const c = this.peek();
      if (c !== "+" && c !== "-") break;
      this.pos++; this.ws();
      const right = this.parseTerm();
      const op: Op = c === "+" ? "add" : "sub";
      left = { kind: "binop", op, left, right, span: { start, end: this.pos } };
    }
    return left;
  }

  /** term ::= factor (("*" | "/") factor)*   — left associative */
  parseTerm(): Expr {
    const start = this.pos;
    let left = this.parseFactor();
    for (;;) {
      const c = this.peek();
      if (c !== "*" && c !== "/") break;
      this.pos++; this.ws();
      const right = this.parseFactor();
      const op: Op = c === "*" ? "mul" : "div";
      left = { kind: "binop", op, left, right, span: { start, end: this.pos } };
    }
    return left;
  }

  parseFactor(): Expr {
    const start = this.pos;
    if (this.peek() === "(") {
      this.symbol("(");
      const inner = this.parseExpr();
      this.symbol(")");
      // Re-wrap so the outer span covers the parens too
      return { ...inner, span: { start, end: this.pos } };
    }
    if (isDigit(this.peek())) {
      const { value, span } = this.integer();
      return { kind: "lit", value, span };
    }
    if (isIdentStart(this.peek())) {
      const { name, span } = this.identifier();
      return { kind: "var", name, span };
    }
    this.fail("expected literal, identifier, or '('");
  }
}

class ParseFailure extends Error {
  offset: number;
  constructor(offset: number, message: string) {
    super(message);
    this.offset = offset;
  }
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isIdentRest(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function offsetToLineCol(src: string, offset: number): { line: number; col: number } {
  let line = 1, col = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") { line++; col = 1; } else { col++; }
  }
  return { line, col };
}

// ==========================================================================
// 2. Code generation — symbolic instructions with origin spans
// ==========================================================================
//
// Mirrors CodeGen.hs almost line-for-line. The two peephole optimizations
// from the reference compiler are preserved:
//   • right operand is a known variable → emit memory-form opcode against
//     it directly, skipping the temporary store
//   • right operand is a literal AND op is Add → emit `addn` with the
//     immediate, skipping the literal-stash temporary
//
// Returned shape: a flat list of SymInst plus the variable list and the
// peak number of temporary slots needed by any single statement.

type CodeGenOutput = {
  insts: SymInst[];
  vars: { name: string; span: Span }[];
  maxTemps: number;
};

function genProgram(prog: Program): CodeGenOutput {
  const vars = collectVars(prog);
  let allInsts: SymInst[] = [];
  let maxT = 0;
  for (const s of prog) {
    const { insts, temps } = genStmt(vars.map((v) => v.name), s);
    allInsts = allInsts.concat(insts);
    if (temps > maxT) maxT = temps;
  }
  // Halt span = end of last statement (or 0..0 if the program is empty)
  const last = prog[prog.length - 1];
  const haltSpan: Span = last
    ? { start: last.span.end, end: last.span.end }
    : { start: 0, end: 0 };
  allInsts.push({ op: "halt", addr: null, span: haltSpan });
  return { insts: allInsts, vars, maxTemps: maxT };
}

function collectVars(prog: Program): { name: string; span: Span }[] {
  const out: { name: string; span: Span }[] = [];
  for (const s of prog) {
    const name = s.name;
    if (out.some((v) => v.name === name)) {
      throw new CompileFailure({ kind: "duplicateDecl", name, span: s.span });
    }
    out.push({ name, span: s.span });
  }
  return out;
}

function genStmt(vars: string[], s: Stmt): { insts: SymInst[]; temps: number } {
  if (s.kind === "declEmpty") return { insts: [], temps: 0 };
  const { insts, temps } = genExpr(vars, s.expr);
  // The trailing store carries the span of the whole declaration so that
  // clicking either the LHS or the RHS in source highlights the store.
  insts.push({ op: "store", addr: { kind: "var", name: s.name }, span: s.span });
  return { insts, temps };
}

function genExpr(vars: string[], e: Expr): { insts: SymInst[]; temps: number } {
  if (e.kind === "lit") {
    if (e.value < 0 || e.value > 255) {
      throw new CompileFailure({ kind: "literalOutOfRange", n: e.value, span: e.span });
    }
    return {
      insts: [{ op: "loadn", addr: { kind: "imm", value: e.value }, span: e.span }],
      temps: 0,
    };
  }

  if (e.kind === "var") {
    if (!vars.includes(e.name)) {
      throw new CompileFailure({ kind: "undefinedVar", name: e.name, span: e.span });
    }
    return {
      insts: [{ op: "loadm", addr: { kind: "var", name: e.name }, span: e.span }],
      temps: 0,
    };
  }

  // BinOp — inspect the right operand for the two fast paths.
  const r = e.right;
  const memOp = mnemonicForOp(e.op);

  if (r.kind === "var") {
    if (!vars.includes(r.name)) {
      throw new CompileFailure({ kind: "undefinedVar", name: r.name, span: r.span });
    }
    const lhs = genExpr(vars, e.left);
    lhs.insts.push({ op: memOp, addr: { kind: "var", name: r.name }, span: e.span });
    return lhs;
  }

  if (r.kind === "lit") {
    if (r.value < 0 || r.value > 255) {
      throw new CompileFailure({ kind: "literalOutOfRange", n: r.value, span: r.span });
    }
    if (e.op === "add") {
      const lhs = genExpr(vars, e.left);
      lhs.insts.push({ op: "addn", addr: { kind: "imm", value: r.value }, span: e.span });
      return lhs;
    }
    // Non-add literal: stash the immediate to a temp first, generate lhs,
    // then combine. Same shape as the Haskell compiler.
    const lhs = genExpr(vars, e.left);
    const tIdx = lhs.temps;
    const stash: SymInst[] = [
      { op: "loadn", addr: { kind: "imm", value: r.value }, span: r.span },
      { op: "store", addr: { kind: "tmp", idx: tIdx }, span: r.span },
    ];
    return {
      insts: stash.concat(lhs.insts).concat([
        { op: memOp, addr: { kind: "tmp", idx: tIdx }, span: e.span },
      ]),
      temps: lhs.temps + 1,
    };
  }

  // General case: lhs → tmp_L, rhs → tmp_R, recombine.
  const lhs = genExpr(vars, e.left);
  const rhs = genExpr(vars, e.right);
  const tL = rhs.temps;
  const tR = tL + 1;
  const newMax = Math.max(lhs.temps, tR + 1);
  const insts: SymInst[] = [
    ...lhs.insts,
    { op: "store", addr: { kind: "tmp", idx: tL }, span: e.left.span },
    ...rhs.insts,
    { op: "store", addr: { kind: "tmp", idx: tR }, span: e.right.span },
    { op: "loadm", addr: { kind: "tmp", idx: tL }, span: e.left.span },
    { op: memOp, addr: { kind: "tmp", idx: tR }, span: e.span },
  ];
  return { insts, temps: newMax };
}

function mnemonicForOp(op: Op): Mnemonic {
  switch (op) {
    case "add": return "addm";
    case "sub": return "subm";
    case "mul": return "mulm";
    case "div": return "divm";
  }
}

// ==========================================================================
// 3. Linker — assign concrete RAM addresses
// ==========================================================================
//
// Layout (matches link in CodeGen.hs):
//
//     [ instructions ][ user vars ][ scratch temps ]
//        0 .. N-1      N .. N+V-1    N+V .. N+V+T-1
//
// Total must fit in THMM's 256-word memory.

const MEM_CAPACITY = 256;

function link(cg: CodeGenOutput): { instructions: ThmmInst[]; varMap: VarBinding[] } {
  const numInsts = cg.insts.length;
  const numVars = cg.vars.length;
  const total = numInsts + numVars + cg.maxTemps;
  if (total > MEM_CAPACITY) {
    throw new CompileFailure({ kind: "programTooLarge", used: total, capacity: MEM_CAPACITY });
  }

  const varAddrs = new Map<string, number>();
  const varMap: VarBinding[] = cg.vars.map((v, i) => {
    const addr = numInsts + i;
    varAddrs.set(v.name, addr);
    return { name: v.name, addr, span: v.span };
  });
  const tmpBase = numInsts + numVars;

  const instructions: ThmmInst[] = cg.insts.map((s) => {
    let arg = 0;
    if (s.addr) {
      switch (s.addr.kind) {
        case "imm": arg = s.addr.value; break;
        case "var": {
          const a = varAddrs.get(s.addr.name);
          if (a === undefined) {
            // Unreachable in practice — undefined vars caught in codegen.
            throw new CompileFailure({ kind: "undefinedVar", name: s.addr.name, span: s.span });
          }
          arg = a;
          break;
        }
        case "tmp": arg = tmpBase + s.addr.idx; break;
      }
    }
    return finalize(s.op, arg, s.span);
  });

  return { instructions, varMap };
}

// ==========================================================================
// 4. Encoder — opcode << 12 | operand, then to 16-char bit string
// ==========================================================================

const OPCODE: Record<Mnemonic, number> = {
  halt:  0x1,
  loadm: 0x2,
  loadn: 0x3,
  store: 0x4,
  addm:  0x7,
  addn:  0x8,
  subm:  0xa,
  mulm:  0xb,
  divm:  0xc,
};

function finalize(op: Mnemonic, arg: number, span: Span): ThmmInst {
  const operand = op === "halt" ? 0 : arg & 0xff;
  const word = (OPCODE[op] << 12) | operand;
  const bits = word.toString(2).padStart(16, "0");
  const hex = word.toString(16).padStart(4, "0").toUpperCase();
  const asm = op === "halt" ? "halt" : `${op} ${operand}`;
  return { op, arg: operand, bits, hex, asm, span };
}

// ==========================================================================
// 5. Top-level entry point
// ==========================================================================

class CompileFailure extends Error {
  err: CompileError;
  constructor(err: CompileError) { super(err.kind); this.err = err; }
}

export function compile(source: string): CompileResult {
  let ast: Program;
  try {
    const p = new Parser(source);
    ast = p.parseProgram();
  } catch (e) {
    if (e instanceof ParseFailure) {
      const { line, col } = offsetToLineCol(source, e.offset);
      return {
        ok: false,
        error: { kind: "parse", offset: e.offset, line, col, message: e.message },
      };
    }
    throw e;
  }

  try {
    const cg = genProgram(ast);
    const { instructions, varMap } = link(cg);
    return {
      ok: true,
      ast,
      symInsts: cg.insts,
      maxTemps: cg.maxTemps,
      instructions,
      varMap,
    };
  } catch (e) {
    if (e instanceof CompileFailure) return { ok: false, error: e.err };
    throw e;
  }
}

/**
 * Render a symbolic instruction in human-readable form, with addresses still
 * shown as labels (variable names or `tN`). Used by the codegen and link
 * scenes; mirrors the asm strings from CodeGen.hs's reference output.
 */
export function symInstToAsm(s: SymInst): string {
  if (s.op === "halt") return "halt";
  const a = s.addr;
  if (!a) return s.op;
  switch (a.kind) {
    case "imm": return `${s.op} ${a.value}`;
    case "var": return `${s.op} ${a.name}`;
    case "tmp": return `${s.op} t${a.idx}`;
  }
}

export function formatError(err: CompileError): string {
  switch (err.kind) {
    case "parse":
      return `parse error (line ${err.line}, col ${err.col}): ${err.message}`;
    case "undefinedVar":
      return `undefined variable: ${err.name}`;
    case "duplicateDecl":
      return `duplicate declaration: ${err.name}`;
    case "literalOutOfRange":
      return `literal ${err.n} out of range; THMM's loadn supports [0, 255]`;
    case "programTooLarge":
      return `program too large: ${err.used} cells needed, only ${err.capacity} available`;
  }
}

/**
 * Render a successful compile as one bit-string per line, with `// addr: asm`
 * comments — exactly the format the existing program editor parses.
 */
export function instructionsToBitsSource(insts: ThmmInst[]): string {
  return insts
    .map((inst, i) => `${inst.bits}  // ${pad3(i)}: ${inst.asm}`)
    .join("\n") + "\n";
}

function pad3(n: number): string {
  return n.toString().padStart(3, " ");
}

// Demo source strings live in ./programs.ts.
