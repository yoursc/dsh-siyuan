# SiYuan HTTP API — Exact Cheat Sheet

Extracted from `/tmp/syapi.md` (SiYuan official API doc, Chinese). Covers exactly the requested endpoints.
**All listed endpoints are `POST`.**

## Conventions (from the doc's 规范 section)

- **Base URL:** `http://127.0.0.1:6806`
- **Method:** `POST` unless an endpoint says otherwise.
- **Body:** JSON string placed in the request body with header `Content-Type: application/json`.
- **Auth header:** `Authorization: Token xxx` (token from 设置 - 鉴权 - API token).
- **Envelope:**
  ```json
  {
    "code": 0,
    "msg": "",
    "data": {}
  }
  ```
  - `code`: non-zero means an exceptional/error situation; `0` means the interface reported no error (it does **not** mean indexes/caches/WebSocket broadcasts/sync are updated).
  - `msg`: empty string on success, error text on failure.
  - `data`: may be `{}`, `[]`, or `NULL` depending on the endpoint.
- **HTTP status:** the doc ties success/failure to `code`, not HTTP status; it does not define HTTP-status semantics for the endpoints below. HTTP status is documented only for a few non-standard endpoints (`/api/file/getFile`: `200` = file content, `202` = error JSON; proxy endpoints pass the target service's status through). Treat non-zero `code` as the error signal here.
- **Types:** the doc gives JSON examples, not type declarations. Types below are inferred from those examples. Anything the doc leaves genuinely unclear is flagged as such.

## Parent anchoring: `insertBlock` vs `moveBlock`

`insertBlock` request-body fields: `dataType`, `data`, `nextID`, `previousID`, `parentID`.

- `nextID`: ID of the **next** block, used to anchor the insertion position.
- `previousID`: ID of the **previous** block, used to anchor the insertion position (sibling anchor).
- `parentID`: **parent block ID**, used to anchor the insertion position (child-of anchor).
- At least one of `nextID` / `previousID` / `parentID` must have a value; **priority is `nextID` > `previousID` > `parentID`**.
- `moveBlock`: `previousID` and `parentID` cannot both be empty; if both are present, `previousID` takes priority.
- `prependBlock` / `appendBlock` take **only `parentID`** (prepend = as first child, append = as last child).
- **Which block types can be parents (leaf blocks): NOT documented.** The doc contains no list of block types permitted as `parentID` and no statement that leaf blocks cannot be parents. The only related documented constraint is under `updateBlock`: illegal parent-child structures are always rejected, and an empty paragraph can convert to any valid block type.

---

## 笔记本 / Notebook

### POST /api/notebook/lsNotebooks
Request (no params):
```json
{}
```
Response `data`:
```json
{
  "notebooks": [
    {
      "id": "20210817205410-2kvfpfn",
      "name": "测试笔记本",
      "icon": "1f41b",
      "sort": 0,
      "closed": false
    }
  ]
}
```
- `notebooks`: array of objects (required/core).
- element fields: `id` string, `name` string, `icon` string, `sort` number, `closed` boolean. Doc does not state null/absence for these.

### POST /api/notebook/getNotebookConf
Request:
```json
{
  "notebook": "20210817205410-2kvfpfn"
}
```
Response `data`:
```json
{
  "box": "20210817205410-2kvfpfn",
  "conf": {
    "name": "测试笔记本",
    "closed": false,
    "refCreateSavePath": "",
    "createDocNameTemplate": "",
    "dailyNoteSavePath": "/daily note/{{now | date \"2006/01\"}}/{{now | date \"2006-01-02\"}}",
    "dailyNoteTemplatePath": ""
  },
  "name": "测试笔记本"
}
```
- `notebook`: string, notebook ID.
- `data.box` string, `data.name` string, `data.conf` object with `name` string, `closed` boolean, `refCreateSavePath` string, `createDocNameTemplate` string, `dailyNoteSavePath` string, `dailyNoteTemplatePath` string.

## 文档 / Documents

### POST /api/filetree/createDocWithMd
Request:
```json
{
  "notebook": "20210817205410-2kvfpfn",
  "path": "/foo/bar",
  "markdown": ""
}
```
Response `data`:
```json
"20210914223645-oj2vnx2"
```
- `notebook`: string, notebook ID. `path`: string, must start with `/`, levels separated by `/` (corresponds to DB `hpath` field). `markdown`: string, GFM Markdown content.
- `data`: string, the created document ID.
- Note: calling repeatedly with the same `path` does **not** overwrite the existing document.

### POST /api/filetree/getIDsByHPath
Request:
```json
{
  "path": "/foo/bar",
  "notebook": "20210808180117-czj9bvb"
}
```
Response `data`:
```json
[
  "20200813004931-q4cu8na"
]
```
- `path`: string, human-readable path. `notebook`: string, notebook ID.
- `data`: array of strings (IDs).

### POST /api/filetree/getHPathByID
Request:
```json
{
  "id": "20210917220056-yxtyl7i"
}
```
Response `data`:
```json
"/foo/bar"
```
- `id`: string, block ID.
- `data`: string, human-readable path.

### POST /api/filetree/getPathByID
Request:
```json
{
  "id": "20210808180320-fqgskfj"
}
```
Response `data`:
```json
{
  "notebook": "20210808180117-czj9bvb",
  "path": "/20200812220555-lj3enxa/20210808180320-fqgskfj.sy"
}
```
- `id`: string, block ID.
- `data.notebook` string, `data.path` string (storage path).

### POST /api/filetree/moveDocsByID
Request:
```json
{
  "fromIDs": ["20210917220056-yxtyl7i"],
  "toID": "20210817205410-2kvfpfn"
}
```
Response `data`:
```json
null
```
- `fromIDs`: array of strings, source document IDs. `toID`: string, target parent document ID **or** notebook ID.
- `data`: `null`.

### POST /api/filetree/renameDocByID
Request:
```json
{
  "id": "20210902210113-0avi12f",
  "title": "文档新标题"
}
```
Response `data`:
```json
null
```
- `id`: string, document ID. `title`: string, new title.
- `data`: `null`.

### POST /api/filetree/removeDocByID
Request:
```json
{
  "id": "20210902210113-0avi12f"
}
```
Response `data`:
```json
null
```
- `id`: string, document ID.
- `data`: `null`.

## 资源文件 / Assets

### POST /api/asset/upload
Request — **HTTP Multipart form, NOT a JSON body**:
```json
{
  "assetsDirPath": "string — folder path rooted at the data folder, e.g. \"/assets/\"",
  "file[]": "file[] — list of uploaded files (one or more)"
}
```
Response `data`:
```json
{
  "errFiles": ["bar.png"],
  "failedFiles": [
    {
      "index": 1,
      "name": "bar.png",
      "error": "disk full"
    }
  ],
  "succFiles": [
    {
      "index": 0,
      "name": "foo.png",
      "path": "assets/foo-20210719092549-9j5y79r.png"
    }
  ],
  "succMap": {
    "foo.png": "assets/foo-20210719092549-9j5y79r.png"
  }
}
```
- `assetsDirPath`: string. `"/assets/"` = workspace/data/assets/, `"/assets/sub/"` = workspace/data/assets/sub/; the former is recommended.
- `errFiles`: array of strings — file names that hit an error during processing.
- `failedFiles`: array of objects — files explicitly reported failed; `index` number (index in `file[]`), `name` string (upload file name), `error` string. May omit files not attempted or not individually reported.
- `succFiles`: array of objects — successes in input order; `index` number, `name` string, `path` string (uploaded asset path). Use this to unambiguously identify every input item.
- `succMap`: object `{ [uploadName]: "assets/foo-id.png" }`, kept for compatibility; on duplicate file names only the last entry per key is kept.
- Note: the doc's example shows `code: 0` together with `msg: "disk full"` and non-empty `errFiles`.

## 块 / Blocks

### POST /api/block/appendBlock (插入后置子块)
Request:
```json
{
  "data": "foo**bar**{: style=\"color: var(--b3-font-color8);\"}baz",
  "dataType": "markdown",
  "parentID": "20220107173950-7f9m1nb"
}
```
Response `data`:
```json
[
  {
    "doOperations": [
      {
        "action": "insert",
        "data": "<div data-node-id=\"20220108003642-y2wmpcv\" data-node-index=\"1\" data-type=\"NodeParagraph\" class=\"p\"><div contenteditable=\"true\" spellcheck=\"false\">foo<strong style=\"color: var(--b3-font-color8);\">bar</strong>baz</div><div class=\"protyle-attr\" contenteditable=\"false\"></div></div>",
        "id": "20220108003642-y2wmpcv",
        "parentID": "20220107173950-7f9m1nb",
        "previousID": "20220108003615-7rk41t1",
        "retData": null
      }
    ],
    "undoOperations": null
  }
]
```
- `data`: string, content to insert. `dataType`: string enum `markdown` | `dom`. `parentID`: string, parent block ID (anchor).
- `action.data`: DOM generated for the new block. `action.id`: new block ID. In the append example `previousID` is the existing last child's ID.

### POST /api/block/prependBlock (插入前置子块)
Request:
```json
{
  "data": "foo**bar**{: style=\"color: var(--b3-font-color8);\"}baz",
  "dataType": "markdown",
  "parentID": "20220107173950-7f9m1nb"
}
```
Response `data`:
```json
[
  {
    "doOperations": [
      {
        "action": "insert",
        "data": "<div data-node-id=\"20220108003710-hm0x9sc\" data-node-index=\"1\" data-type=\"NodeParagraph\" class=\"p\"><div contenteditable=\"true\" spellcheck=\"false\">foo<strong style=\"color: var(--b3-font-color8);\">bar</strong>baz</div><div class=\"protyle-attr\" contenteditable=\"false\"></div></div>",
        "id": "20220108003710-hm0x9sc",
        "parentID": "20220107173950-7f9m1nb",
        "previousID": "",
        "retData": null
      }
    ],
    "undoOperations": null
  }
]
```
- Same request fields as `appendBlock`. `action.data` = generated DOM, `action.id` = new block ID. In the prepend example `previousID` is `""`.

### POST /api/block/insertBlock (插入块)
Request:
```json
{
  "dataType": "markdown",
  "data": "foo**bar**{: style=\"color: var(--b3-font-color8);\"}baz",
  "nextID": "",
  "previousID": "20211229114650-vrek5x6",
  "parentID": ""
}
```
Response `data`:
```json
[
  {
    "doOperations": [
      {
        "action": "insert",
        "data": "<div data-node-id=\"20211230115020-g02dfx0\" data-node-index=\"1\" data-type=\"NodeParagraph\" class=\"p\"><div contenteditable=\"true\" spellcheck=\"false\">foo<strong style=\"color: var(--b3-font-color8);\">bar</strong>baz</div><div class=\"protyle-attr\" contenteditable=\"false\"></div></div>",
        "id": "20211230115020-g02dfx0",
        "parentID": "",
        "previousID": "20211229114650-vrek5x6",
        "retData": null
      }
    ],
    "undoOperations": null
  }
]
```
- `dataType`: string enum `markdown` | `dom`. `data`: string.
- `nextID` / `previousID` / `parentID`: string; at least one must have a value; priority `nextID` > `previousID` > `parentID`.
- `action.data` = generated DOM, `action.id` = new block ID.

### POST /api/block/updateBlock (更新块)
Request:
```json
{
  "dataType": "markdown",
  "data": "foobarbaz",
  "id": "20211230161520-querkps",
  "lockType": false
}
```
Response `data`:
```json
[
  {
    "doOperations": [
      {
        "action": "update",
        "data": "<div data-node-id=\"20211230161520-querkps\" data-node-index=\"1\" data-type=\"NodeParagraph\" class=\"p\"><div contenteditable=\"true\" spellcheck=\"false\">foo<strong>bar</strong>baz</div><div class=\"protyle-attr\" contenteditable=\"false\"></div></div>",
        "id": "20211230161520-querkps",
        "parentID": "",
        "previousID": "",
        "retData": null
      }
    ],
    "undoOperations": null
  }
]
```
- `dataType`: string enum `markdown` | `dom`. `data`: string. `id`: string, block ID to update.
- `lockType`: boolean, default `false`; when the parsed block type differs from the original, refuse the update. Illegal parent-child structures are always rejected; an empty paragraph can be converted to any valid block type.
- `action.data` = DOM generated by the update.

### POST /api/block/deleteBlock (删除块)
Request:
```json
{
  "id": "20211230161520-querkps"
}
```
Response `data`:
```json
[
  {
    "doOperations": [
      {
        "action": "delete",
        "data": null,
        "id": "20211230162439-vtm09qo",
        "parentID": "",
        "previousID": "",
        "retData": null
      }
    ],
    "undoOperations": null
  }
]
```
- `id`: string, block ID to delete. `action` is `delete` and `action.data` is `null`.

### POST /api/block/moveBlock (移动块)
Request:
```json
{
  "id": "20230406180530-3o1rqkc",
  "previousID": "20230406152734-if5kyx6",
  "parentID": "20230404183855-woe52ko"
}
```
Response `data`:
```json
[
  {
    "doOperations": [
      {
        "action": "move",
        "data": null,
        "id": "20230406180530-3o1rqkc",
        "parentID": "20230404183855-woe52ko",
        "previousID": "20230406152734-if5kyx6",
        "nextID": "",
        "retData": null,
        "srcIDs": null,
        "name": "",
        "type": ""
      }
    ],
    "undoOperations": null
  }
]
```
- `id`: string, block ID to move. `previousID`: string, previous-block anchor. `parentID`: string, parent-block anchor. `previousID` and `parentID` cannot both be empty; if both exist, `previousID` wins.
- Operation object adds `nextID` (string), `srcIDs` (null in example; type not stated by doc), `name` (string), `type` (string) relative to the insert/update operations.

### POST /api/block/getBlockKramdown (获取块 kramdown 源码)
Request:
```json
{
  "id": "20201225220955-l154bn4"
}
```
Response `data`:
```json
{
  "id": "20201225220955-l154bn4",
  "kramdown": "* {: id=\"20201225220955-2nn1mns\"}新建笔记本，在笔记本下新建文档\n  {: id=\"20210131155408-3t627wc\"}\n* {: id=\"20201225220955-uwhqnug\"}在编辑器中输入 <kbd>/</kbd> 触发功能菜单\n  {: id=\"20210131155408-btnfw88\"}\n* {: id=\"20201225220955-04ymi2j\"}((20200813131152-0wk5akh \"在内容块中遨游\"))、((20200822191536-rm6hwid \"窗口和页签\"))\n  {: id=\"20210131155408-hh1z442\"}"
}
```
- `id`: string, block ID to fetch. `data.id` string, `data.kramdown` string.
- Determinism: returned Kramdown normalizes block-level IAL attribute order; order stays stable while block content and attributes are unchanged.

### POST /api/block/getChildBlocks (获取子块)
Request:
```json
{
  "id": "20230506212712-vt9ajwj"
}
```
Response `data`:
```json
[
  {
    "id": "20230512083858-mjdwkbn",
    "type": "h",
    "subType": "h1"
  },
  {
    "id": "20230513213727-thswvfd",
    "type": "s"
  },
  {
    "id": "20230513213633-9lsj4ew",
    "type": "l",
    "subType": "u"
  }
]
```
- `id`: string, parent block ID. Blocks below a heading also count as child blocks.
- `data`: array of objects; `id` string, `type` string, `subType` string. `subType` is absent in some example elements → optional / may be absent. Doc does not define the full enum of `type`/`subType`.

## 属性 / Attributes

### POST /api/attr/getBlockAttrs (获取块属性)
Request:
```json
{
  "id": "20210912214605-uhi5gco"
}
```
Response `data`:
```json
{
  "custom-attr1": "line1\nline2",
  "id": "20210912214605-uhi5gco",
  "title": "PDF 标注双链演示",
  "type": "doc",
  "updated": "20210916120715"
}
```
- `id`: string, block ID.
- `data`: object mapping attribute name → string value (e.g. `id`, `title`, `type`, `updated`, and `custom-*` keys). The doc shows values as strings; it does not state a fixed key set.

### POST /api/attr/setBlockAttrs (设置块属性)
Request:
```json
{
  "id": "20210912214605-uhi5gco",
  "attrs": {
    "custom-attr1": "line1\nline2"
  }
}
```
Response `data`:
```json
null
```
- `id`: string, block ID. `attrs`: object of attribute name → string value; custom attributes must use the `custom-` prefix.
- `data`: `null`.

## SQL

### POST /api/query/sql (执行 SQL 查询)
Request:
```json
{
  "stmt": "SELECT * FROM blocks WHERE content LIKE'%content%' LIMIT 7"
}
```
Response `data`:
```json
[
  { "列": "值" }
]
```
- `stmt`: string, SQL statement.
- `data`: array of objects; each object's keys are column names and values are the column values (the doc shows the generic placeholder `{ "列": "值" }`; it does not further type the values). Empty result is presumably `[]`/`null` but the doc does not state it — treat as unstated.
- Security note: this endpoint is forbidden in publish mode (发布模式).
- **未验证（本插件的防护不依赖它）**：官方文档没说这个接口是否只读、是否接受分号分隔的多语句。`siyuan_sql` 因此自己只放行单条 SELECT（剥掉结尾分号后仍有分号即拒绝），不指望思源替我们拦。即便日后实测确认"只读且只接受单语句"，这层本地校验也应保留——它让模型看到的是明确拒绝，而不是语义不明的服务端失败。
- 同样未验证：SQL 出错时是否返回 `code`/`msg` 信封。插件按与其他接口一致的假设处理（`code != 0` 即失败），具体错误文案未实测。

## 模板 / Template

### POST /api/template/renderSprig (渲染 Sprig)
Request:
```json
{
  "template": "/daily note/{{now | date \"2006/01\"}}/{{now | date \"2006-01-02\"}}"
}
```
Response `data`:
```json
"/daily note/2023/03/2023-03-24"
```
- `template`: string, template content (Sprig).
- `data`: string, rendered result.

## 导出 / Export

### POST /api/export/exportMdContent (导出 Markdown 文本)
Request:
```json
{
  "id": ""
}
```
Response `data`:
```json
{
  "hPath": "/0 请从这里开始",
  "content": "## 🍫 内容块\n\n在思源中，唯一重要的核心概念是..."
}
```
- `id`: string, document block ID to export.
- `data.hPath`: string, human-readable path. `data.content`: string, Markdown content.
