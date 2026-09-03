// 临时验证脚本：三档矩阵的权限切换 + 磁盘暗号校验。
// 只重写 ~/.dsh/settings.yaml 中 dsh-sub-cli 段的 permissions 三个键
// （经用户明确授权，见 VERIFICATION-FLOW 三档矩阵任务），其余字节不动。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const yamlPath = path.join(os.homedir(), ".dsh", "settings.yaml");
const TIERS = {
	"read-only": { read: true, write: false, exec: false },
	"workspace-write": { read: true, write: true, exec: false },
	"danger-full-access": { read: true, write: true, exec: true }
};

const raw = fs.readFileSync(yamlPath, "utf8");
const section = /dsh-sub-cli:\n([\s\S]*?)(?=\n[a-zA-Z][\w-]*:|$)/.exec(raw);
if (!section) { console.error("no dsh-sub-cli section"); process.exit(2); }
const body = section[1];

// Replace the permissions block (flow-style or block-style) with the new tier.
const permBlock = /  permissions:\n?[\s\S]*?(?=\n  [a-zA-Z])/;
if (!permBlock.test(body)) { console.error("no permissions block found"); process.exit(2); }
const tier = TIERS[process.argv[2]];
if (!tier) { console.error(`usage: node set-permission.mjs <read-only|workspace-write|danger-full-access>`); process.exit(2); }
const one = `{ read: ${tier.read}, write: ${tier.write}, exec: ${tier.exec} }`;
const newBody = body.replace(permBlock, `  permissions:\n    {\n      codex: ${one},\n      claude: ${one},\n      qwen: ${one}\n    }\n`);
const next = raw.slice(0, section.index + "dsh-sub-cli:\n".length) + newBody + raw.slice(section.index + section[0].length);
fs.writeFileSync(yamlPath, next, "utf8");
console.log(`permissions -> ${process.argv[2]} (${one})`);
