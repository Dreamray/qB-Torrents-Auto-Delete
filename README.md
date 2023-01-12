# qB-Torrents-Auto-Delete

## 特点

 * 根据最近一段时间内种子的平均上传速删种，可避免一开始上传很快最后很慢，计算整个活动时间内的平均上传速度依然很快从而不删的情况
 * 磁盘空间不足时删除上次活动时间距现在最久的种子
 * 有辅种处理逻辑，删除种子前检测有无同名或同大小种子，有则只删除种子保留文件
 * HR逻辑，不会删除HR时间或分享率未达标的种子（虽然刷流一般不加HR种但还是实现了此功能）
 * 只支持qb，只在Windows版qb 4.4.3.1 版本中测试通过
 * 默认打开testMode，运行一段时间，确定不会出现误删后再关闭

## 使用方法：
1. Chrome浏览嚣安装Tampermonkey扩展程序
2. 复制qb torents auto delete.user.js文件内的所有代码
3. 打开Tampermonkey的管理面板，点击“+”号新建用户脚本
4. 删除编辑框内自动生成的代码，粘贴刚才复制的代码
5. 把代码内第7行 “// @match        http://127.0.0.1:60009/*” 内的IP和端口改成你自己qb webui的IP和端口
6. 修改代码的 设置部分，改成你想要的设置
7. 根据自己情况分别修改代码的 hrTrackerHourRatio、shuaPathList、keepCategoryList 部分
8. Chrome打开qb的Web UI登录一次
9. Chrome打开 “http://你的qb地址:端口/api/v2/torrents/info?filter=paused” ，F12打开控制台，查看运行情况
   - 之所以推荐打开此地址，是因为此地址不像webui那样会定时刷新，省资源占用，如果你觉得打开webui更方便也可以
10. 默认打开testMode，会以暂停代替删除，测试一段时间，查看被脚本暂停的种子，如没有误删，则把testMode的值改为0
