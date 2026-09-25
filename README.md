# Bilibili-Clickbait-Filter

过滤 B 站营销号的篡改猴插件，对 B 站主页或任意视频页面右侧的推荐视频生效。

在推荐视频卡片出现后，自动根据发布视频频率等自定义规则检测营销号，并过滤隐藏。

注：该过程受限于 B 站公开 API 的频率限制，实际隐藏可能有几秒延迟。

## 安装方式

- 确保浏览器已安装篡改猴 (Tampermonkey) 插件。
- [点击此链接](https://raw.githubusercontent.com/MnFeN/Bilibili-Clickbait-Filter/main/Bilibili-Clickbait-Filter.user.js)，按提示安装即可。

## 配置方式

- 安装并进入 B 站主页后，在浏览器顶部点击篡改猴图标打开配置界面：

<p align="center">
  <img width="500" alt="篡改猴配置入口" src="https://github.com/user-attachments/assets/e734e30b-b531-4367-af1c-5d56082149c9">
</p>

- 配置界面中可以调整各项筛选策略，及设置 UP 主、关键词的黑白名单。
  
  每项右侧问号标记处悬停鼠标可见详细说明。

<p align="center">
  <img width="500" alt="配置界面" src="https://github.com/user-attachments/assets/8858d0b3-f674-4c84-80c8-737260652bd7">
</p>
