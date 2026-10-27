#!/usr/bin/env python3
"""计量思源内置 agent 工具的「提示词字数」。

用法（先按 docs/DEV.md 的「思源参考源码」拉好稀疏检出）：
    python3 docs/research/count-siyuan-descriptions.py
    SIYUAN_SRC=/somewhere/else python3 docs/research/count-siyuan-descriptions.py

解析 tmp/siyuan-src/kernel/mcp/tools/*.go 里的 &Tool{...} 字面量：
  - Name 字段
  - Description 字段（可能是 "a" + "b" + fmt.Sprintf(...) 的多行拼接）
  - InputSchema.Properties 里每个 Property 的 Description
  - Enum 的取值本身也是给模型看的提示词，一并计入
"""
import re, os, glob, json

REPO = os.environ.get(
    "SIYUAN_SRC",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tmp", "siyuan-src"),
)
BASE = os.path.join(REPO, "kernel", "mcp", "tools")
if not os.path.isdir(BASE):
    raise SystemExit(
        f"找不到 {BASE}\n"
        "先按 docs/DEV.md 的「思源参考源码」拉取稀疏检出，或用 SIYUAN_SRC=<路径> 指定。"
    )

# Go 字符串字面量：处理转义 \n \" \\ 和反引号裸字符串
def unquote_go(s):
    s = s.strip()
    if s.startswith('`') and s.endswith('`'):
        return s[1:-1]
    if not (s.startswith('"') and s.endswith('"')):
        return s
    body = s[1:-1]
    out, i = [], 0
    while i < len(body):
        c = body[i]
        if c == '\\' and i + 1 < len(body):
            nxt = body[i+1]
            out.append({'n':'\n','t':'\t','r':'\r','"':'"','\\':'\\'}.get(nxt, '\\'+nxt))
            i += 2
        else:
            out.append(c); i += 1
    return ''.join(out)

# 从 `Description:` 起吃掉所有 + 连接的字符串字面量，直到遇到非字符串 token
STR_RE = re.compile(r'`[^`]*`|"(?:\\.|[^"\\])*"')

def grab_concat(src, start):
    """从 start 抓取连续拼接的字符串字面量：第一个字面量 + 若干个 `+ 字面量`。"""
    pos, seen, parts = start, False, []
    while pos < len(src):
        if not seen:
            seen = True
        else:
            m = re.compile(r'\s*\+').match(src, pos)
            if not m:
                break
            pos = m.end()
        sm = STR_RE.match(src, pos)
        if not sm:
            rest = src[pos:].lstrip()
            if rest.startswith(('fmt.', 'strings.', 'skill', 'util.', 'capability', 'ListCap')):
                depth, i = 0, pos
                while i < len(src):
                    if src[i] == '(': depth += 1
                    elif src[i] == ')':
                        depth -= 1
                        if depth == 0: i += 1; break
                    elif src[i] in '"`':
                        q = src[i]; i += 1
                        while i < len(src) and src[i] != q:
                            i += 2 if src[i] == '\\' else 1
                    i += 1
                parts.append('<DYNAMIC>')
                pos = i
                continue
            break
        parts.append(unquote_go(sm.group(0)))
        pos = sm.end()
    return parts, pos

def find_tool_blocks(src):
    """切出所有 &Tool{ ... } 字面量块。"""
    for m in re.finditer(r'&Tool\{', src):
        depth, i = 0, m.end() - 1
        while i < len(src):
            if src[i] == '{': depth += 1
            elif src[i] == '}':
                depth -= 1
                if depth == 0: break
            # 跳过字符串字面量里的花括号
            if src[i] in '"`':
                q = src[i]; i += 1
                while i < len(src) and src[i] != q:
                    i += 2 if src[i] == '\\' else 1
            i += 1
        yield m.start(), src[m.end()-1:i+1]

def count_props(block):
    """统计 InputSchema 区域里每个 Property 的 Description / Enum 字数。"""
    idx = block.find('InputSchema:')
    if idx < 0:
        return 0, 0, 0
    region = block[idx:]
    n_props, chars, n_desc = 0, 0, 0
    for pm in re.finditer(r'Description:\s*', region):
        parts, _ = grab_concat(region, pm.end())
        if not parts: continue
        val = ''.join(parts)
        if val == '<DYNAMIC>': continue
        chars += len(val); n_desc += 1
    for em in re.finditer(r'Enum:\s*\[\]string\{([^}]*)\}', region):
        n_props += 1
        for lit in STR_RE.finditer(em.group(1)):
            chars += len(unquote_go(lit.group(0))); n_props += 0
    return n_desc, chars, n_props

rows = []
dynamic = []
for f in sorted(glob.glob(os.path.join(BASE, "*.go"))):
    if f.endswith('_test.go'):
        continue
    src = open(f, encoding='utf-8').read()
    for start, block in find_tool_blocks(src):
        nm = re.search(r'Name:\s*("[^"]*")', block)
        if not nm: continue
        name = unquote_go(nm.group(1))
        dm = re.search(r'Description:\s*', block)
        if not dm: continue
        parts, _ = grab_concat(block, dm.end())
        desc = ''.join(parts)
        if '<DYNAMIC>' in desc:
            dynamic.append((name, os.path.basename(f)))
        n_desc, param_chars, n_enum = count_props(block)
        rows.append({
            'name': name, 'file': os.path.basename(f),
            'desc': len(desc), 'params': param_chars, 'nparamdesc': n_desc,
            'dynamic': '<DYNAMIC>' in desc,
        })

rows.sort(key=lambda r: -r['desc'])
print('| 工具 | 文件 | 工具描述 | 参数描述 | 小计 |')
print('| --- | --- | ---: | ---: | ---: |')
for r in rows:
    mark = ' ⚠动态' if r['dynamic'] else ''
    print(f"| `{r['name']}` | {r['file']} | {r['desc']}{mark} | {r['params']} | {r['desc']+r['params']} |")
td = sum(r['desc'] for r in rows); tp = sum(r['params'] for r in rows)
print(f"| **合计（{len(rows)} 个内核工具）** | | **{td}** | **{tp}** | **{td+tp}** |")
print()
print('动态拼接（未计入字面量部分）：', dynamic)
print('单工具均值：', round((td+tp)/len(rows)), '字符')
