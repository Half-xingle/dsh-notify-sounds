// 临时渲染模拟测试：与宿主 showPopup 完全相同的代码路径
// （buildPopupCommand + spawn powershell.exe + windowsHide + stdio ignore）
import { spawn } from "node:child_process";
import { buildPopupCommand } from "../lib/index.js";

const args = buildPopupCommand({
	title: "DSH · 模拟弹窗",
	body: "渲染测试：如果你能看到这个小窗，渲染链路是通的",
	seconds: 10
});
console.log("spawning:", args[0], args.slice(1, 4).join(" "));
const child = spawn("powershell.exe", args, {
	windowsHide: true,
	stdio: "ignore"
});
child.on("error", (error) => console.log("spawn error:", error.message));
child.on("exit", (code) => console.log("popup process exited:", code));
console.log("spawned pid:", child.pid);
