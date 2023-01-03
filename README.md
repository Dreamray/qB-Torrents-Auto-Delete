# qB-Torrents-Auto-Delete

使用方法：
1. Chrome浏览嚣安装Tampermonkey扩展程序
2. 复制qb torents auto delete.user文件内的所有代码
3. 打开Tampermonkey的管理面板，点击“+”号新建用户脚本
4. 删除编辑框内自动生成的代码，粘贴刚才复制的代码
5. 把代码内第7行 “// @match        http://127.0.0.1:54321/*” 内的IP和端口改成你自己qb webui的IP和端口
6. 修改代码的 设置部分，改成你想要的设置
7. 根据自己情况分别修改代码的 hrTrackerHourRatio、shuaPathList、keepCategoryList
8. Chrome打开 “http://你的qb地址:端口/api/v2/torrents/info?filter=paused” ，F12打开控制台，查看运行情况
   - 之所以推荐打开此地址，是因为此地址不像webui那样会定时刷新，省资源占用，如果你觉得打开webui更方便也可以
9. 默认打开testMode，会以暂停代替删除，测试一段时间，查看被脚本暂停的种子，如没有误删，则把testMode的值改为0


HR时间、HR分享率部分没做测试，一般不会问题，但也不保证不出问题
