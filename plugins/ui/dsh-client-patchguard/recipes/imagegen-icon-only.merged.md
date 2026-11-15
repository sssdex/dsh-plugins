{
  "id": "imagegen-icon-only",
  "title": "image-gen 输入栏生图按钮改为纯图标",
  "why": "生图胶囊在工具条里还占着「图标 + OpenAI 兼容 + 箭头」约 112px。文字与箭头都能从悬停提示 / 菜单里拿到，按钮只保留图像图标：28×28、999px 圆角、透明底、label-secondary（与宿主原生图标按钮同尺寸同色），图标 15px、描边与宿主图标同档。文字藏起来后 aria-label 与 title 都带当前 provider/渠道名，鼠标悬停与读屏都能拿到。",
  "package": "dsh-image-gen",
  "file": "lib/client.js",
  "testedWith": [
    "0.11.1"
  ],
  "pristineSha256": "7FE574EEA09E3A075519D9CB977F353F891DF990CE649F15A8CA17943074D81E",
  "patchedSha256": "5554CCD03639BF66ACF1687B5C4E19310D8EC2038DDD50C1A740C3DC3536384E",
  "pristineMarkers": [
    ".dsh-ig-pill-button{display:inline-flex;align-items:center;gap:4px;height:22px",
    ".dsh-ig-pill-provider{max-width:96px"
  ],
  "appliedMarkers": [
    ".dsh-ig-pill-button{display:inline-flex;align-items:center;justify-content:center;gap:0;width:28px;height:28px",
    ".dsh-ig-pill-provider{display:none"
  ],
  "ops": [
    {
      "tag": "pill root 高度 22 → 28",
      "old": ".dsh-ig-pill-root{position:relative;display:inline-flex;align-items:center;height:22px}",
      "new": ".dsh-ig-pill-root{position:relative;display:inline-flex;align-items:center;height:28px}"
    },
    {
      "tag": "pill button: 22px 文字胶囊 → 28×28 纯图标按钮",
      "old": ".dsh-ig-pill-button{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s,color .15s;-webkit-user-select:none;user-select:none}",
      "new": ".dsh-ig-pill-button{display:inline-flex;align-items:center;justify-content:center;gap:0;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;cursor:pointer;transition:background .15s,color .15s;-webkit-user-select:none;user-select:none}"
    },
    {
      "tag": "pill icon: 去掉 opacity，跟随 currentColor",
      "old": ".dsh-ig-pill-icon{flex:none;color:currentColor;opacity:.85}",
      "new": ".dsh-ig-pill-icon{flex:none;color:currentColor}"
    },
    {
      "tag": "pill provider 文本：隐藏",
      "old": ".dsh-ig-pill-provider{max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "new": ".dsh-ig-pill-provider{display:none}"
    },
    {
      "tag": "pill caret：隐藏（含旋转过渡一并去掉）",
      "old": ".dsh-ig-pill-caret{display:inline-flex;flex:none;transition:transform .15s}\n.dsh-ig-pill-caret-open{transform:rotate(180deg)}",
      "new": ".dsh-ig-pill-caret{display:none}\n.dsh-ig-pill-caret-open{display:none}"
    },
    {
      "tag": "容器查询：文字/箭头隐藏后，这三条规则已无对象（整块换成说明注释）",
      "old": "@container (max-width:700px){\n  .dsh-ig-pill-caret{display:none}\n  .dsh-ig-pill-button{padding:0 5px}\n  .dsh-ig-pill-provider{max-width:72px}\n}\n",
      "new": "/* 本地补丁：按钮已改为纯图标，文字与箭头常隐，原来针对它们的容器查询规则一并移除了。 */\n"
    },
    {
      "tag": "pill icon svg: 12 → 15",
      "old": "className: \"dsh-ig-pill-icon\",\n\t\t\t\t\t\t\twidth: \"12\",\n\t\t\t\t\t\t\theight: \"12\",",
      "new": "className: \"dsh-ig-pill-icon\",\n\t\t\t\t\t\t\twidth: \"15\",\n\t\t\t\t\t\t\theight: \"15\","
    },
    {
      "tag": "pill button: 补 aria-label（带当前 provider/渠道名）",
      "old": "\t\t\t\t\ttitle: writable ? t(\"menuTitle\") : t(\"readOnly\"),\n\t\t\t\t\tdisabled: !writable,",
      "new": "\t\t\t\t\ttitle: t(\"menuTitle\") + \"：\" + pillButtonLabel(current, PILL_PROVIDER_LABELS[lang][current], snapshot.value, currentChannel?.label) + (writable ? \"\" : \"（\" + t(\"readOnly\") + \"）\"),\n\t\t\t\t\t\"aria-label\": t(\"menuTitle\") + \"：\" + pillButtonLabel(current, PILL_PROVIDER_LABELS[lang][current], snapshot.value, currentChannel?.label),\n\t\t\t\t\tdisabled: !writable,"
    }
  ]
}