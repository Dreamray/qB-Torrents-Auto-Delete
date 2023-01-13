// ==UserScript==
// @name         qB Torrents Auto Delete
// @namespace    -
// @version      2.1
// @description  qBittorrent Torrents Auto Delete
// @author       Dreamray
// @match        http://127.0.0.1:60009/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /**
     * 根据最近一段时间内种子的平均上传速删种，可避免一开始上传很快最后很慢，计算整个活动时间内的平均上传速度依然很快从而不删的情况
     * 磁盘空间不足时删除上次活动时间距现在最久的种子
     * 有辅种处理逻辑，删除种子前检测有无同名或同大小种子，有则只删除种子保留文件
     * HR逻辑，不会删除HR时间或分享率未达标的种子（虽然刷流一般不加HR种但还是实现了此功能）
     * 只支持qb，只在Windows版qb 4.4.3.1 版本中测试通过
     * 默认打开testMode，运行一段时间，确定不会出现误删后再关闭
     */

    //设置部分：
    const
        testMode            = 1,   //测试模式用暂停代替删种，防止误删。测试无误后可修改值为0关闭
        cycle               = 2,   //删种周期，即向qb发起检查请求的周期，单位分钟
        averageUpSpeedScale = 384, //上传速度标尺，单位KB/s，timeScale时间内的上传速度小于此值，会被删
        // timeActiveScale  = 5,   //（已弃用）最小活动时间标尺，单位分钟，种子活动时间高于此值才计算活动时间内的平均上传速度
        timeScale           = 5,   //时间标尺，此时间内平均上传速度低于averageUpSpeedScale会被删，单位分钟。例：值为5表示5分钟前到现在的时间段
        // upSpeedScale     = 350, //（已弃用）上传速度标尺，单位KB
        stalledDLTimeScale  = 30,  //种子未开始下载或下载中断后的等待时间标尺，超过此值会被删，单位分钟
        queuedDLTimeScale   = 20,  //种子由于队列设置未开始下载的等待时间标尺，超过此值会被删，单位分钟（刷流工具有时会一次添加多个种子，而由于qb的最大活动下载数设置导致有排队下载的情况适用）
        minFreeSpace        = 5,   //最小磁盘剩余空间，单位GB，小于此数值时会删除上次活动时间最久的种子，建议设置为删种周期内最大下载数据量的2倍或更多倍
        hrTrackerHourRatio  = {    //有HR站点的 tracker地址域名部分：{HR时长,分享率}
            'pt.btschool.club':{hour:20,ratio:1}, //HR时长 和 分享率 通常为或关系，即一个达到要求即可
            'www.nicept.net':{hour:120,ratio:2},
            '52pt.site':{hour:24,ratio:-1}, //-1表示无分享率选项（无视分享率，只考察HR时长）
            'tracker.torrentleech.org':{hour:240,ratio:-1},
            'tracker.tleechreload.org':{hour:240,ratio:-1},
            'ptsbao.club':{hour:24,ratio:-1}
        },
        shuaPathList = [ //刷流种子存放路径，只删除以下目录内的种子（不包括子目录，如果种子存放在以下目录的子目录中，子目录也必须加到此列表），建议刷流种子统一放此目录中。注意windows系统冒号后两个斜杠，其它系统请自行修改
            'E:\\PT-Shua'
        ],
        keepCategoryList = [ //保留的分类，不删除以下分类的种子
            'Movie',
            'TV',
            'H',
            'Music',
            'Exam'
        ];
    if(window.Notification && Notification.permission !== "granted"){
        Notification.requestPermission(function (status) {
            if (Notification.permission !== status) {
                Notification.permission = status;
            }
        });
    };
    let
        hrTrackers = Object.keys(hrTrackerHourRatio),
        hrHourRatio = Object.values(hrTrackerHourRatio),
        checkTime = Math.ceil(timeScale / cycle) + 1, //算出需要检查的最小次数，检查次数大于等于此值，时间才能符合timeScale设置，才能计算timeScale时间内的平均上传速度
        mutiCheckTorrentsSorted = [],
        countOccurrences = (arr,val) => arr.reduce((a, v) => (v === val ? a + 1 : a), 0),
    isHrTracker = function(tracker){
        if(hrTrackers.indexOf(tracker.split('/')[2]) !== -1){
            return true;
        }else{
            return false
        }
    },
    isHrFinished = function(tracker,seedingTime,torrentRatio){
        let domain = tracker.split('/')[2];
        if(hrHourRatio[hrTrackers.indexOf(domain)].ratio > 0){
            if(
                seedingTime > hrHourRatio[hrTrackers.indexOf(domain)].hour * 3600 + 600 || //做种时间达标了(保险起见比站点规定的HR时间多10分钟，不确定这10分钟有没有必要)
                torrentRatio > hrHourRatio[hrTrackers.indexOf(domain)].ratio //或者分享率达标了
            ){
                return true;
            }else{
                return false;
            }
        }else{
            if(
                seedingTime > hrHourRatio[hrTrackers.indexOf(domain)].hour * 3600 + 600 //做种时间达标了(保险起见比站点规定的HR时间多10分钟，不确定这10分钟有没有必要)
            ){
                return true;
            }else{
                return false;
            }
        }
    },
    isShuaFolder = function(savePath){
        if(shuaPathList.indexOf(savePath) !== -1){
            return true;
        }else{
            return false;
        }
    },
    isKeepCategory = function(category){
        if(keepCategoryList.indexOf(category) !== -1){
            return true;
        }else{
            return false;
        }
    },
    isAveUpspeedTooLow = function(hash){
        let indexOfFirstCheck = -1,
            indexOfLastCheck  = -1,
            mutiCheckdownloadingTimes = 0,
            j,
            k;
        for(j=0;j<mutiCheckTorrentsSorted.length;j++){ //循环 每次检查后得到种子列表所存放的数组
            for(k=mutiCheckTorrentsSorted[j].length-1;k>=0;k--){ //循环 数组中的每个种子列表。用倒序循环是因为downloading状态的种子按last_activity由久到新排列肯定排到最后，能尽快break，减少循环次数
                if(mutiCheckTorrentsSorted[j][k].infohash_v1 == hash){ //hash相同，找到种子所在位置了，注意：每次检查的的此种子位置可能不一样，因为活种的last_activity是不断变化的
                    if(j==0){
                        indexOfFirstCheck = k; //数组中首个种子列表中的此种子的index，可能没有（种子刚添加）
                    };
                    if(j==mutiCheckTorrentsSorted.length-1){
                        indexOfLastCheck = k; //数组中最后一个种子列表中的此种子的index
                    };
                    if(mutiCheckTorrentsSorted[j][k].state == 'downloading'){ //该种子是不是downloading状态
                        mutiCheckdownloadingTimes++; //是的话，记录一次
                    }
                    break;
                }
            }
        };
        // console.log('mutiCheckdownloadingTimes:'+mutiCheckdownloadingTimes);
        // console.log('indexOfFirstCheck:'+indexOfFirstCheck);
        // console.log('indexOfLastCheck:'+indexOfLastCheck);
        if(mutiCheckdownloadingTimes == checkTime){ //每次检查都是downloading状态才删种，一共检查了checkTime次，每次都是downloading状态，所以downloading状态的次数=检查数次
            let averageUpspeed = (mutiCheckTorrentsSorted[mutiCheckTorrentsSorted.length - 1][indexOfLastCheck].uploaded - mutiCheckTorrentsSorted[0][indexOfFirstCheck].uploaded) / (cycle * (checkTime - 1) * 60);
            console.log('averageUpspeed:'+Math.round(averageUpspeed/1024*100)/100+'KB/s');
            if(averageUpspeed < averageUpSpeedScale * 1024){ //平均速度小于设定值
                return averageUpspeed; //返回平均速度，供后边删除种子时log输出
            }else{
                return false; //只返回假就可以，后边用不到速度值
            }
        }
    },
    deleteTorrent = function(hash,name,size,domain,reason,isDeleteFile,callback){
        let 
            method = testMode ? 'pause' : 'delete',
            param = testMode ? '' : '&deleteFiles=' + isDeleteFile,
            deletedTorrentIndex = 0,
            xhrDelete = new XMLHttpRequest();
        xhrDelete.open('GET', '/api/v2/torrents/' + method + '?hashes=' + hash + param, true);
        xhrDelete.send();
        xhrDelete.onreadystatechange = function () {
            if(xhrDelete.readyState == 4 && ((xhrDelete.status >= 200 && xhrDelete.status < 300) || xhrDelete.status == 304)){
                deletedTorrentIndex++;
                let nowTime = new Date();
                console.log('%c' + nowTime.toLocaleTimeString() + '：成功删除第 ' + deletedTorrentIndex + ' 个 -> ' + name + ' --> ' + size + 'GB --->' +domain + ' ----> 原因：' + reason,'color:#f29766');
                callback();
                if(window.Notification && Notification.permission === "granted"){
                    let notify = new Notification('种子已删除',{
                        icon:'https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/New_qBittorrent_Logo.svg/60px-New_qBittorrent_Logo.svg.png',
                        body:name
                    });
                    notify.onclick = function(){
                        window.top.focus();
                    }
                }
            }
        }
    },
    checkAndDelete = function(){
        let nowTime,
            nowUnixTime = Math.floor(Date.now() / 1000), //现在时间，unix格式
            willDelTorrentsSum = 0,
            fileDeletedTorrentsSum = 0,
            xhrMaindata = new XMLHttpRequest();
        xhrMaindata.open('GET', '/api/v2/sync/maindata', true);
        xhrMaindata.send();
        xhrMaindata.onreadystatechange = function () {
            if(xhrMaindata.readyState == 4 && ((xhrMaindata.status >= 200 && xhrMaindata.status < 300) || xhrMaindata.status == 304)){
                let maindata = JSON.parse(xhrMaindata.responseText),
                    diskFreeSpace = maindata.server_state.free_space_on_disk,
                    connectionStatus = maindata.server_state.connection_status,
                    torrents = Object.values(maindata.torrents),
                    torrentsSorted = torrents.sort((obj1, obj2) => (obj1.last_activity > obj2.last_activity) ? 1 : (obj1.last_activity < obj2.last_activity) ? -1 : 0), //由小到大排序，即距现在最久在最前
                    torrentsSortedNames = torrentsSorted.map(item =>{
                        return item.name
                    }),
                    torrentsSortedSizes = torrentsSorted.map(item =>{
                        return item.size
                    });
                if(mutiCheckTorrentsSorted.length < checkTime){
                    mutiCheckTorrentsSorted.push(torrentsSorted);
                }else{
                    mutiCheckTorrentsSorted.shift();
                    mutiCheckTorrentsSorted.push(torrentsSorted);
                }; //这个if else的意思是：把每次检查的种子列表存到数组，此数组的长度根据需要的检查次数得出，多了就去掉第一个，然后在末尾追加，所以数据永远是最新的，供后边取uploaded计算平均速度
                // console.log(mutiCheckTorrentsSorted);
                for(let i=0;i<torrentsSorted.length;i++){
                    if(
                        isShuaFolder(torrentsSorted[i].save_path) && //路径是刷流专放路径
                        !isKeepCategory(torrentsSorted[i].category) //非 保留的分类
                    ){
                        // if(
                        //     torrentsSorted[i].state == 'downloading' && //正在下载的种子
                        //     torrentsSorted[i].infohash_v1
                        //     mutiCheckTorrentsSorted[3].
                        //     torrentsSorted[i].time_active > timeActiveScale * 60 && //活动时间大于设定值
                        //     torrentsSorted[i].uploaded / torrentsSorted[i].time_active < averageUpSpeedScale * 1024 && //活动时间内平均速度小于设定值
                        //     torrentsSorted[i].upspeed < upSpeedScale * 1024 && //本次检查时的上传速度小于设定值
                        //     torrentsSorted[i].downloaded > torrentsSorted[i].dlspeed * timeActiveScale * 60 //总下载量大于设定时间内的近似下载量（防止种子添加后长时间等待下载，刚开始下载时就被删除的情况（time_active包括等待下载的时间所以达到设定值了），添加这一条件后能基本保证下载时间持续timeActiveScale以上）
                        // )
                        if(torrentsSorted[i].state == 'downloading'){ //正在下载的种子
                            let aveUpspeed = isAveUpspeedTooLow(torrentsSorted[i].infohash_v1); //判断上传速度，返回结果赋值，上传速度小于设定值则返回上传速度，否则返回false
                            if(aveUpspeed){
                                if(
                                    torrentsSorted[i].progress < 0.5 //进度小于50%，无需考虑hr
                                ){
                                    willDelTorrentsSum++;
                                    deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'最近 ' + timeScale + ' 分钟内平均上传速度 ' + Math.round(aveUpspeed/1024*100)/100 + ' < ' + averageUpSpeedScale + ' KB/s',true,function(){ //删除文件
                                        console.log('%c' + '文件已删除，停止继续删种，等待下一次检查','color:#f29766');
                                    });
                                    fileDeletedTorrentsSum++;
                                    break;
                                };
                                if(
                                    torrentsSorted[i].progress >= 0.5 && //进度大于50%，需要考虑hr
                                    !isHrTracker(torrentsSorted[i].tracker) //非 有hr
                                ){
                                    willDelTorrentsSum++;
                                    deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'最近 ' + timeScale + ' 分钟内平均上传速度 ' + Math.round(aveUpspeed/1024*100)/100 + ' < ' + averageUpSpeedScale + ' KB/s',true,function(){ //删除文件
                                        console.log('%c' + '文件已删除，停止继续删种，等待下一次检查','color:#f29766');
                                    });
                                    fileDeletedTorrentsSum++;
                                    break;
                                }
                            }
                        };
                        if(
                            torrentsSorted[i].state == 'stalledDL' && //未开始下载或下载中断的种子
                            nowUnixTime - torrentsSorted[i].added_on > stalledDLTimeScale * 60 && //等待下载时间超过设定值
                            connectionStatus == 'connected' //防止断网后无下载时的误删
                        ){
                            if(
                                torrentsSorted[i].progress < 0.5 //进度小于50%，无需考虑hr
                            ){
                                willDelTorrentsSum++;
                                deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'等待下载时间 > ' + stalledDLTimeScale + '分钟',true,function(){ //删除文件
                                    console.log('%c' + '文件已删除，停止继续删种，等待下一次检查','color:#f29766');
                                });
                                if(torrentsSorted[i].downloaded > 512*1024*1024){ //删除的文件大于512MB就break，不处理其它种子了，否则继续处理其它
                                    fileDeletedTorrentsSum++;
                                    break;
                                }
                            };
                            if(
                                torrentsSorted[i].progress >= 0.5 && //进度大于50%，需要考虑hr
                                !isHrTracker(torrentsSorted[i].tracker) //非 有hr
                            ){
                                willDelTorrentsSum++;
                                deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'等待下载时间 > ' + stalledDLTimeScale + '分钟',true,function(){ //删除文件
                                    console.log('%c' + '文件已删除，停止继续删种，等待下一次检查','color:#f29766');
                                });
                                if(torrentsSorted[i].downloaded > 512*1024*1024){ //删除的文件大于512MB就break，不处理其它种子了，否则继续处理其它
                                    fileDeletedTorrentsSum++;
                                    break;
                                }
                            }
                        };
                        if(
                            torrentsSorted[i].state == 'queuedDL' && //排队下载的种子
                            nowUnixTime - torrentsSorted[i].added_on > queuedDLTimeScale * 60 //排队等待下载时间超过设定值
                        ){
                            willDelTorrentsSum++;
                            deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'队列下载时间 > ' + queuedDLTimeScale + '分钟',true,function(){ //删除文件
                                console.log('%c' + '种子已删除，继续处理其它种子','color:#f29766');
                            });
                            if(torrentsSorted[i].downloaded > 512*1024*1024){ //删除的文件大于512MB就break，不处理其它种子了，否则继续处理其它
                                fileDeletedTorrentsSum++;
                                break;
                            }
                        };
                        if(
                            diskFreeSpace < minFreeSpace * 1024 * 1024 * 1024 && //磁盘空间小于设定值
                            torrentsSorted[i].state == 'stalledUP' //做种但没在上传的种子
                        ){
                            if(
                                !isHrTracker(torrentsSorted[i].tracker) //非 有hr
                            ){
                                if(
                                    countOccurrences(torrentsSortedNames,torrentsSorted[i].name) > 1 || countOccurrences(torrentsSortedSizes,torrentsSorted[i].size) > 1 //有辅种
                                ){
                                    willDelTorrentsSum++;
                                    deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'磁盘空间不足，删除上次活动时间最久的种子(有辅种，保留文件)',false,function(){ //不删除文件
                                        console.log('%c' + '文件未删除，磁盘空间仍不足，继续删种','color:#f29766');
                                    })
                                }else{ //无辅种
                                    willDelTorrentsSum++;
                                    setTimeout(function(){
                                        deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'磁盘空间不足，删除上次活动时间最久的种子和文件',true,function(){ //删除文件
                                            console.log('%c' + '文件已删除，停止继续删种，等待下一次检查磁盘剩余空间','color:#f29766');
                                        });
                                    },2000)
                                    fileDeletedTorrentsSum++;
                                    break;
                                }
                            };
                            if(
                                isHrTracker(torrentsSorted[i].tracker) && //有hr
                                (torrentsSorted[i].downloaded == 0 || isHrFinished(torrentsSorted[i].tracker,torrentsSorted[i].seeding_time,torrentsSorted[i].ratio)) //下载数据量为0不考虑hr或hr达标了
                            ){
                                if(
                                    countOccurrences(torrentsSortedNames,torrentsSorted[i].name) > 1 || countOccurrences(torrentsSortedSizes,torrentsSorted[i].size) > 1 //有辅种
                                ){
                                    willDelTorrentsSum++;
                                    deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'磁盘空间不足，删除上次活动时间最久的种子(有辅种，保留文件)',false,function(){ //不删除文件
                                        console.log('%c' + '文件未删除，磁盘空间仍不足，继续删种','color:#f29766');
                                    })
                                }else{ //无辅种
                                    willDelTorrentsSum++;
                                    setTimeout(function(){
                                        deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'磁盘空间不足，删除上次活动时间最久的种子和文件',true,function(){ //删除文件
                                            console.log('%c' + '文件已删除，停止继续删种，等待下一次检查磁盘剩余空间','color:#f29766');
                                        });
                                    },2000)
                                    fileDeletedTorrentsSum++;
                                    break;
                                }
                            }
                        }
                    }
                };
                if(willDelTorrentsSum > 0){
                    nowTime = new Date();
                    console.log('%c' + nowTime.toLocaleTimeString() + '：本次检查共有 ' + willDelTorrentsSum + ' 个符合删除条件的种子','color:#f29766');
                };
                let titleScrollInterval,
                    l=0;
                if(fileDeletedTorrentsSum == 0 && diskFreeSpace < minFreeSpace * 1024 * 1024 * 1024){
                    document.title = '红种警告：磁盘即将爆仓，请修改设置或手动删种　　';
                    titleScrollInterval = setInterval(function(){
                        document.title = document.title.substring(1) + document.title.charAt(0);
                        l++;
                    },1000);
                    if(window.Notification && Notification.permission === "granted"){
                        let notify = new Notification('红种警告',{
                            icon:'https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/New_qBittorrent_Logo.svg/60px-New_qBittorrent_Logo.svg.png',
                            body:'磁盘即将爆仓，请修改设置或手动删种'
                        });
                        notify.onclick = function(){
                            window.top.focus();
                        };
                    };
                    setTimeout(function(){
                            nowTime = new Date();
                            console.log('%c' + nowTime.toLocaleTimeString() + '：没有可删除文件的种子，磁盘即将爆仓，请检查种子分类、路径设置或修改脚本的保留分类/刷流路径或手动删种','background-color:#d12f2e;color:#e8eaed');
                    },2000);
                }else if(l > 0){
                    clearInterval(titleScrollInterval);
                    document.title = '';
                    l = 0;
                }
            }
        }
    };
    checkAndDelete();
    setInterval(checkAndDelete, cycle * 60000);
})();
