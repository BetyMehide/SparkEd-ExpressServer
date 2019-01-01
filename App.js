//requires
var express = require("express");
var bodyParser = require("body-parser");
var ISOLATION_LEVEL = require('tedious').ISOLATION_LEVEL;
var Connection = require('tedious').Connection;
var Request = require('tedious').Request;
var multer = require('multer')
const {Aborter, BlockBlobURL, ContainerURL, downloadBlobToBuffer, ServiceURL, SharedKeyCredential, StorageURL} = require('@azure/storage-blob');
const fs = require("fs");
const path = require("path");

//server variables
var storage = multer.memoryStorage()
var upload = multer({preservePath: true, storage: storage});
var app = express();
const PORT = process.env.PORT || 80
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

//db variables
var config={
    userName: process.env.dbUserName,
    password: process.env.dbPsw,
    server: process.env.dbServer,
    options:{
        database: process.env.dbName,
        encrypt: true,
        enableArithAbort: true,
        connectionIsolationLevel: ISOLATION_LEVEL.READ_UNCOMMITTED
    }
}

//filestorage variables
if (process.env.NODE_ENV !== "production") {
    require("dotenv").config();
}
const STORAGE_ACCOUNT_NAME = process.env.fsAccountName;
const ACCOUNT_ACCESS_KEY = process.env.fsAccessKey;
const ONE_MEGABYTE = 1024 * 1024;
const FOUR_MEGABYTES = 4 * ONE_MEGABYTE;
const ONE_MINUTE = 60 * 1000;

//db querying functions
async function connectDatabase(sqlQuery, res){
    var connection = new Connection(config);
    //connect
    return await connection.on('connect', function(err){
        if(err){
            console.log(err);
            connection.close();         
        }
        else{
            queryDatabase(sqlQuery, connection, res);
        }
    });
};

async function queryDatabase(sqlQuery, connection, res){
    console.log('Reading rows form the Table...');
    
    //prep request handling
    //send query request
    request = new Request(
        sqlQuery,
        function(err, rowCount, rows){
            if (err) {
                console.log('Query: ' + sqlQuery);
                console.log('Statement failed: ' + err);
            } else {
                console.log('Query: ' + sqlQuery);
                console.log(rowCount + 'row(s) returned');
            }
            connection.close();   
        }
    );

    //read response
    var results = {rows:[]};
    request.on('row', function(columns) {
        var row = {};
        columns.forEach(function(column){
            if (column.value == null) { //THIS IS CURRENTLY NEVER EXECUTING?
                result = 'null';
            }
            else{
                result=column.value;
            }
            row[column.metadata.colName] = result;         
        });
        results.rows.push(row); 
    });

    //send response
    request.on('requestCompleted', function () {
        console.log('Results: ' + results);
        res.send(results);
     });

    //execute sql request
    connection.execSql(request);
}

//filestorage access
async function execute(command, blobName, content) {
    const containerName = "sparked";

    //set up file storage connection
    const credentials = new SharedKeyCredential(STORAGE_ACCOUNT_NAME, ACCOUNT_ACCESS_KEY);
    const pipeline = StorageURL.newPipeline(credentials);
    const serviceURL = new ServiceURL(`https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`, pipeline);
    
    const containerURL = ContainerURL.fromServiceURL(serviceURL, containerName);
    const blockBlobURL = BlockBlobURL.fromContainerURL(containerURL, blobName);
    
    const aborter = Aborter.timeout(30 * ONE_MINUTE);

    //upload blob
    if(command == 'upload'){
        await blockBlobURL.upload(aborter, content, content.length);
        console.log('Blob uploaded');
        return 'uploaded'
    }
    
    //donwload blob from sotrage
    if(command == 'download'){
        const buffer = Buffer.alloc(parseInt(content));
        await downloadBlobToBuffer(Aborter.timeout(30*60*60*1000), buffer, blockBlobURL, 0, undefined, {blockSize: 4*1024*1024, parallelism: 20, progress: ev => console.log(ev)});
        console.log('downloadBlobToBuffer success');
        console.log(buffer);
        return buffer;
    }

    //delete blob from storage 
    //TODO: integrate with the rest of the application
    if(command == 'delete'){
        await blockBlobURL.delete(aborter);
        console.log(`Block blob "${blobName}" is deleted`);
        return 'deleted'
    }    
}

//Endpoints
//check that server works
app.post("/", function(req, res) {
    res.status(200).send("server working");
});

//load user's saved games
app.get("/Home", function(req, res) {
    console.log(req.body)
    let userID = req.query.userID;
    var sqlQuery = `SELECT gameID, instance, published, storyName, responded FROM GamesData 
                    WHERE userID=${userID};`
    connectDatabase(sqlQuery, res);
});

//add a new story to a user's list of stories
app.post("/NewStories", function(req, res) {
    console.log(req.body)
    let userID = req.body.userID;
    let gameID = req.body.gameID;
    let instance = req.body.instance;
    var sqlQuery = `INSERT INTO GamesData (userID, gameID, instance, published, storyName, responded )
                    VALUES (${userID}, ${gameID}, ${instance}, 'false', 'Stray Dog', 'false');`
    connectDatabase(sqlQuery, res);
});

//get information about the characters in a user's story
app.get("/CharactersGet", function(req, res) {
    let userID = req.query.userID;
    let gameID = req.query.gameID;
    let instance = req.query.instance;
    var sqlQuery = `SELECT storyName, characters, characterNames FROM GamesData 
                    WHERE userID=${userID} 
                        AND gameID=${gameID} 
                        AND instance=${instance};`
    connectDatabase(sqlQuery, res);
});

//edit the information about the characters in a user's story
app.post("/CharactersPost", function(req, res) {
    let userID = req.body.userID;
    let gameID = req.body.gameID;
    let instance = req.body.instance;
    let storyName = req.body.storyName.replace(/'/g, "''");
    let characters = req.body.characters;
    let characterNames = req.body.characterNames.replace(/'/g, "''");
    var sqlQuery = `UPDATE GamesData
                    SET storyName='${storyName}', characters='${characters}', characterNames='${characterNames}'
                    WHERE userID=${userID}
                        AND gameID=${gameID}
                        AND instance=${instance}`
    connectDatabase(sqlQuery, res);
});

//get information about the input items in a user's story
app.get("/InputGet", function(req, res) {
    let userID = req.query.userID;
    let gameID = req.query.gameID;
    let instance = req.query.instance;
    var sqlQuery = `SELECT inputItems, inputMethods FROM GamesData 
                    WHERE userID=${userID} 
                        AND gameID=${gameID} 
                        AND instance=${instance};`
    connectDatabase(sqlQuery, res);
});

//edit information about the input items in a user's story
app.post("/InputPost", function(req, res) {
    let userID = req.body.userID;
    let gameID = req.body.gameID;
    let instance = req.body.instance;
    let inputItems = req.body.inputItems;
    let inputMethods = req.body.inputMethods;
    var sqlQuery = `UPDATE GamesData
                    SET inputItems='${inputItems}', inputMethods='${inputMethods}'
                    WHERE userID=${userID}
                        AND gameID=${gameID}
                        AND instance=${instance}`
    connectDatabase(sqlQuery, res);
});

//get information about the script and voiceover of a user's story 
app.get("/ScriptGet", function(req, res) {
    let userID = req.query.userID;
    let gameID = req.query.gameID;
    let instance = req.query.instance;
    var sqlQuery = `SELECT scriptText, scriptVoiceover FROM GamesData 
                    WHERE userID=${userID} 
                        AND gameID=${gameID} 
                        AND instance=${instance};`
    connectDatabase(sqlQuery, res);
});

//edit information about the script and voiceover of a user's story
app.post("/ScriptPost", function(req, res) {
    let userID = req.body.userID;
    let gameID = req.body.gameID;
    let instance = req.body.instance;
    let scriptText = req.body.scriptText.replace(/'/g, "''");
    let scriptVoiceover = req.body.scriptVoiceover.replace(/'/g, "''");
    var sqlQuery = `UPDATE GamesData
                    SET scriptText='${scriptText}', scriptVoiceover='${scriptVoiceover}'
                    WHERE userID=${userID}
                        AND gameID=${gameID}
                        AND instance=${instance}`
    connectDatabase(sqlQuery, res);
});

//delete a story from a user's list of stories
app.post("/Delete", function(req, res) {
    let userID = req.body.userID;
    let gameID = req.body.gameID;
    let instance = req.body.instance;
    var sqlQuery = `DELETE FROM GamesData 
                    WHERE userID=${userID} 
                        AND gameID=${gameID} 
                        AND instance=${instance};`
    connectDatabase(sqlQuery, res);
});

//edit information about the published status of a user's story
app.post("/Publish", function(req, res) {
    let userID = req.body.userID;
    let gameID = req.body.gameID;
    let instance = req.body.instance;
    let published = req.body.published;
    var sqlQuery = `UPDATE GamesData
                    SET published='${published}' 
                    WHERE userID=${userID} 
                        AND gameID=${gameID} 
                        AND instance=${instance};`
    connectDatabase(sqlQuery, res);
});

//save the child's interaction information for the parent to view
//TODO: integrate with child side (currently only multiple choice question's answer is being returned)
app.post("/ChildResponses", function(req, res) {
    let userID = 0;
    let gameID = 0;
    let instance = 0;
    let drawImg = req.body.drawImg;
    let cameraImg = req.body.cameraImg;
    let multipleChoice = req.body.multipleChoice.replace(/'/g, "''");
    let openEnded1 = req.body.openEnded1.replace(/'/g, "''");
    let openEnded2 = req.body.openEnded2.replace(/'/g, "''");
    var sqlQuery = `UPDATE GamesData
                    SET responded='true'
                    WHERE userID=${userID}
                        AND gameID=${gameID}
                        AND instance=${instance};
                    
                    UPDATE ChildResponses
                    SET drawImgUrl='${drawImg}', cameraImgUrl='${cameraImg}', multipleChoice='${multipleChoice}', openEnded1='${openEnded1}', openEnded2='${openEnded2}'
                    WHERE userID=${userID}
                    AND gameID=${gameID}
                    AND instance=${instance};`
    connectDatabase(sqlQuery, res);
})

//get the child response information 
app.get("/ChildResponsesGet", function(req, res) {
    let userID = req.query.userID;
    let gameID = req.query.userID;
    let instance = req.query.instance;
    var sqlQuery = `SELECT drawImg, cameraImg, multipleChoice, openEnded1, openEnded2 FROM ChildResponses
                    WHERE userID=${userID}
                        AND gameID=${gameID}
                        AND instance=${instance};`
    connectDatabase(sqlQuery, res);
})

//get a saved blob from the filestorage
app.get("/blobGet", function(req, res) {
    console.log('Blob name: ' + req.query.blobName + 'Blob size: ' + req.query.blobSize);
    let blobName = req.query.blobName;
    let blobSize = req.query.blobSize;   
    let command = 'download';
    execute(command, blobName, blobSize).then((response) => {console.log(response); res.send(response);}).catch((e) => console.log(e));    
})

//save a blob into the filestorage
app.post("/blobPost", upload.single('blobContent'), function(req, res) {
    if(req.file){
        let blobName = req.file.originalname;
        let blobContent = req.file.buffer;
        let command = 'upload';
        response = execute(command, blobName, blobContent).then(() => console.log("done")).catch((e) => console.log(e));
        res.send(response); //IS THIS GETTING DONE?
    }
    else{
        res.send("Error receiving the file.")
    }
})

//start server
var server = app.listen(PORT, function () {
    console.log("app running on port.", server.address().port);
});