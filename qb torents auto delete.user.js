// ==UserScript==
// @name         qB Torrents Auto Delete 2
// @namespace    -
// @version      2.0
// @description  qBittorrent Torrents Auto Delete
// @author       Dreamray
// @match        http://127.0.0.1:60009/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /**
     * 根据最近一段时间内的种子平均上传速删种，可避免一开始上传很快最后很慢，计算整个活动时间的平均上传速度很高的情况
     * 磁盘空间不足时删除上次活动时间距现在最久的种子
     * 辅种处理逻辑，删除做种状态的种子时检测有无同名或同大小种子，有则只删除种子保留文件
     * HR逻辑，不会删除HR时间或分享率未达标的种子（虽然刷流一般不加HR种但还是实现了此功能）
     * 只支持qb，只在qb 4.4.3.1版本中测试通过
     * 默认打开testMode，运行一段时间，确定不会出现误删后再关闭
     */

    //设置部分：
    const
        testMode            = 0,   //测试模式用暂停代替删种，防止误删。测试无误后可修改值为0关闭
        cycle               = 1,   //删种周期，即向qb发起检查请求的周期，单位分钟
        averageUpSpeedScale = 384, //上传速度标尺，单位KB/s，timeScale时间内的上传速度小于此值，会被删
        // timeActiveScale  = 5,   //（已弃用）最小活动时间标尺，单位分钟，种子活动时间高于此值才计算活动时间内的平均上传速度
        timeScale           = 5,   //时间标尺，此时间内平均上传速度低于averageUpSpeedScale会被删，单位分钟。例：值为5表示5分钟前到现在的时间段
        // upSpeedScale     = 350, //（已弃用）上传速度标尺，单位KB
        stalledDLTimeScale  = 20,  //种子未开始下载或下载中断后的等待时间标尺，超过此值会被删，单位分钟
        queuedDLTimeScale   = 20,  //种子由于队列设置未开始下载的等待时间标尺，超过此值会被删，单位分钟（刷流工具有时会一次添加多个种子，而由于qb的最大活动下载数设置导致有排队下载的情况适用）
        minFreeSpace        = 5,   //最小磁盘剩余空间，单位GB，小于此数值时会删除上次活动时间最久的种子，建设设置为删种周期内最大下载数据量的2倍或更多倍
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
        ]
        // ,
        // freeTimeTrackerHour = { //免费时间短的站点tracker：最短免费时间，防止限免到期了还没下完，限免到期前删除(一般情况下用不着，像hh，8小时肯定出种了，不用担心下不完，暂时不实现这个功能了)
        //     'hhanclub.top':7
        // }
    ;
    let
        nowDate,
        maindata,
        torrents,
        torrentsSorted,
        timeNow,
        hrTrackers = Object.keys(hrTrackerHourRatio),
        hrHourRatio = Object.values(hrTrackerHourRatio),
        checkTime = Math.ceil(timeScale / cycle) + 1, //算出需要检查的最小次数，检查次数大于等于此值，时间才能符合timeScale设置，才能计算timeScale时间内的平均上传速度
        mutiCheckTorrentsSorted = [],
        // freeTimeTrackers = Object.keys(freeTimeTrackerHour),
        // freeTimeHours = Object.values(freeTimeTrackerHour),
        method,
        delete_files,
        diskFreeSpace,
        connectionStatus,
        torrentsSortedNames,
        torrentsSortedSizes,
        willDelTorrentsSum,
        fileDeletedTorrentsSum,
        deletedTorrentIndex,
        progress1Sum,
        resumeSuccessSum,

        countOccurrences = (arr, val) => arr.reduce((a, v) => (v === val ? a + 1 : a), 0),
        //setTimeout setInterval
        task = setInterval(check, cycle * 60000)
    ;
    // function isFreeTimeTracker(tracker){
    //     let domain = tracker.split('/');
    //     domain = domain[2];
    //     if(freeTimeTrackers.indexOf(domain) !== -1){
    //         return true;
    //     }else{
    //         return false
    //     }
    // }
    // function isFreeTimeHourExpireSoon(tracker,addedOn){
    //     let domain = tracker.split('/');
    //     domain = domain[2];
    //     let domainIndex = freeTimeTrackers.indexOf(domain);
    //     timeNow = Math.floor(Date.now() / 1000);
    //     if(timeNow - addedOn > freeTimeHours[domainIndex] * 3600){
    //         return true;
    //     }else{
    //         return false;
    //     }
    // }
    function isHrTracker(tracker){
        let domain = tracker.split('/');
        domain = domain[2];
        if(hrTrackers.indexOf(domain) !== -1){
            return true;
        }else{
            return false
        }
    };
    function isHrFinished(tracker,seedingTime,torrentRatio){
        let domain = tracker.split('/');
        domain = domain[2];
        let domainIndex = hrTrackers.indexOf(domain);
        if(hrHourRatio[domainIndex].ratio > 0){
            if(
                seedingTime > hrHourRatio[domainIndex].hour * 3600 + 600 || //做种时间达标了(保险起见比站点规定的HR时间多10分钟，不确定这10分钟有没有必要)
                torrentRatio > hrHourRatio[domainIndex].ratio //或者分享率达标了
            ){
                return true;
            }else{
                return false;
            }
        }else{
            if(
                seedingTime > hrHourRatio[domainIndex].hour * 3600 + 600 //做种时间达标了(保险起见比站点规定的HR时间多10分钟，不确定这10分钟有没有必要)
            ){
                return true;
            }else{
                return false;
            }
        }
    };
    function isShuaFolder(savePath){
        if(shuaPathList.indexOf(savePath) !== -1){
            return true;
        }else{
            return false;
        }
    };
    function isKeepCategory(category){
        if(keepCategoryList.indexOf(category) !== -1){
            return true;
        }else{
            return false;
        }
    };
    function isAveUpspeedTooLow(hash,){

    };
    function deleteTorrent(hash,name,size,domain,reason,deleteFiles,callback){
        method = testMode ? 'pause' : 'delete';
        delete_files = testMode ? '' : '&deleteFiles=' + deleteFiles;
        let xhrDelete = new XMLHttpRequest();
        xhrDelete.open('GET', '/api/v2/torrents/' + method + '?hashes=' + hash + delete_files, true);
        xhrDelete.send();
        xhrDelete.onreadystatechange = function () {
            if (xhrDelete.readyState == 4 && ((xhrDelete.status >= 200 && xhrDelete.status < 300) || xhrDelete.status == 304)) {
                deletedTorrentIndex++;
                nowDate = new Date();
                console.log('%c' + nowDate.toLocaleTimeString() + '：成功删除第 ' + deletedTorrentIndex + ' 个 -> ' + name + ' --> ' + size + 'GB --->' +domain + ' ----> 原因：' + reason,'color:#f29766');
                callback();
            }
        }
    };
    function check(){
        willDelTorrentsSum = 0;
        deletedTorrentIndex = 0;
        fileDeletedTorrentsSum = 0;
        timeNow = Math.floor(Date.now() / 1000); //现在时间，unix格式
        let xhrMaindata = new XMLHttpRequest();
        xhrMaindata.open('GET', '/api/v2/sync/maindata', true);
        xhrMaindata.send();
        xhrMaindata.onreadystatechange = function () {
            if (xhrMaindata.readyState == 4 && ((xhrMaindata.status >= 200 && xhrMaindata.status < 300) || xhrMaindata.status == 304)) {
                maindata = JSON.parse(xhrMaindata.responseText);
                diskFreeSpace = maindata.server_state.free_space_on_disk;
                connectionStatus = maindata.server_state.connection_status;
                torrents = Object.values(maindata.torrents);
                torrentsSorted = torrents.sort((obj1, obj2) => (obj1.last_activity > obj2.last_activity) ? 1 : (obj1.last_activity < obj2.last_activity) ? -1 : 0); //由小到大排序，即距现在最久在最前
                torrentsSortedNames = torrentsSorted.map(item =>{
                    return item.name
                });
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
                            let indexOfFirstCheck = -1, //
                                indexOfLastCheck  = -1,
                                mutiCheckdownloadingTimes = 0,
                                j,
                                k
                            ;
                            for(j=0;j<mutiCheckTorrentsSorted.length;j++){ //循环 每次检查后得到种子列表所存放的数组
                                for(k=mutiCheckTorrentsSorted[j].length-1;k>=0;k--){ //循环 数组中的每个种子列表。用倒序循环是因为downloading状态的种子按last_activity由久到新排列肯定排到最后，能尽快break，减少循环次数
                                    if(mutiCheckTorrentsSorted[j][k].infohash_v1 == torrentsSorted[i].infohash_v1){ //hash相同，找到种子所在位置了，注意：每次检查的的此种子位置可能不一样，因为活种的last_activity是不断变化的
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
                                //console.log(averageUpspeed/1024+'KB/s');
                                if(averageUpspeed < averageUpSpeedScale * 1024){ //平均速度小于设定值
                                    if(
                                        torrentsSorted[i].progress < 0.5 //进度小于50%，无需考虑hr
                                    ){
                                        willDelTorrentsSum++;
                                        deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'最近 ' + timeScale + ' 分钟内平均上传速度 ' + Math.round(averageUpspeed/1024*100)/100 + ' < ' + averageUpSpeedScale + ' KB/s',true,function(){ //删除文件
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
                                        deleteTorrent(torrentsSorted[i].infohash_v1,torrentsSorted[i].name,Math.round(torrentsSorted[i].size/1024/1024/1024*100)/100,torrentsSorted[i].tracker.split('/')[2],'最近 ' + timeScale + ' 分钟内平均上传速度 ' + Math.round(averageUpspeed/1024*100)/100 + ' < ' + averageUpSpeedScale + ' KB/s',true,function(){ //删除文件
                                            console.log('%c' + '文件已删除，停止继续删种，等待下一次检查','color:#f29766');
                                        });
                                        fileDeletedTorrentsSum++;
                                        break;
                                    }
                                }
                            }
                        };
                        if(
                            torrentsSorted[i].state == 'stalledDL' && //未开始下载或下载中断的种子
                            timeNow - torrentsSorted[i].added_on > stalledDLTimeScale * 60 && //等待下载时间超过设定值
                            connectionStatus == 'connected' //防止断网后无下载的误删
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
                            timeNow - torrentsSorted[i].added_on > queuedDLTimeScale * 60 //排队等待下载时间超过设定值
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
                    nowDate = new Date();
                    console.log('%c' + nowDate.toLocaleTimeString() + '：本次检查共有 ' + willDelTorrentsSum + ' 个符合删除条件的种子','color:#f29766');
                };
                let titleScrollInterval,
                    l=0
                ;
                if(fileDeletedTorrentsSum == 0 && diskFreeSpace < minFreeSpace * 1024 * 1024 * 1024){
                    document.title = '红种警告：磁盘即将爆仓，请修改设置或手动删种　　';
                    titleScrollInterval = setInterval(function(){
                        document.title = document.title.substring(1) + document.title.charAt(0);
                        l++;
                    },1000);
                    setTimeout(function(){
                            nowDate = new Date();
                            console.log('%c' + nowDate.toLocaleTimeString() + '：没有可删除文件的种子，磁盘即将爆仓，请检查种子分类、路径设置或修改脚本的保留分类/刷流路径或手动删种','background-color:#d12f2e;color:#e8eaed');
                    },2000);
                }else if(l > 0){
                    clearInterval(titleScrollInterval);
                    document.title = '';
                    l = 0;
                }
            }
        }
    };
    check();
})();
