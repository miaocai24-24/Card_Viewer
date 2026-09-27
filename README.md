# 卡牌收藏（只读快照）

Karuta + Lumina 收藏的静态快照，由本地的 collection manager 导出，托管在 GitHub Pages。

- 数据不含 Discord 用户 ID 和私人备注。
- 页面只读：搜索、筛选、排序、统计都在浏览器里完成。
- 更新方式（在本地项目目录执行）：

```powershell
.\.venv\Scripts\python.exe export_static.py --out C:\Users\HHD\Desktop\karuta-site --title "haide0309 的卡牌收藏"
cd C:\Users\HHD\Desktop\karuta-site
git add -A
git commit -m "更新收藏快照"
git push
```
