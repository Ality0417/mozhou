export function UpdatePanel(): React.JSX.Element {
  return (
    <div className="panel col">
      <h2>墨舟版本</h2>
      <p>当前版本：v{__APP_VERSION__}</p>
      <p className="muted">本分支暂不启用自动更新，不会下载或安装上游更新。更新前请先备份书稿。</p>
      <a href="https://github.com/Ality0417/mozhou" target="_blank" rel="noreferrer">查看墨舟项目与版本说明</a>
    </div>
  )
}
