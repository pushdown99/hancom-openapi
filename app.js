let fs          = require('fs');
let path        = require('path');
let pdf         = require('pdfkit');
let npos        = require('npos');
let request     = require('request');
let http        = require('http');
let https       = require('https');
let express     = require('express');
let moment      = require('moment-timezone');
let nodecache   = require( "node-cache" );
let iconv       = require('iconv-lite');
let mysql       = require('mysql');
let redis       = require('redis');
let rand        = require('random-key');
let exec        = require('child_process').exec;
let dotenv      = require('dotenv').config()
let winston     = require('winston');
let { format: { combine, colorize, timestamp, json }, } = winston;

let router      = express.Router();
let app         = express();

let escpos      = require('escpos'); // ^2.5.2
escpos.Console  = require('escpos-console');


let httpport    = process.env.PORT || 80;
let httpsport   = process.env.PORT || 443; // 55100
let TTL         = 90

// Certificate
let privateKey  = fs.readFileSync('/etc/letsencrypt/live/tric.kr/privkey.pem', 'utf8');
let certificate = fs.readFileSync('/etc/letsencrypt/live/tric.kr/cert.pem',    'utf8');
let ca          = fs.readFileSync('/etc/letsencrypt/live/tric.kr/chain.pem',   'utf8');

let credentials = {
  key: privateKey,
  cert: certificate,
  ca: ca
};

var FCM = require('fcm-node');
var serverKey = process.env.FIREBASE_SERVER_KEY; //put your server key here
var fcm = new FCM(serverKey);

app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.engine('html', require('ejs').renderFile);

app.use(express.json());
app.use(express.urlencoded({ extended: true}));
app.use(express.static(__dirname + '/public'));

/////////////////////////////////////////////////////////////////////////
//
// middleware
//
app.use(function (req, res, next) {
  req.timestamp  = moment().unix();
  req.receivedAt = moment().tz('Asia/Seoul').format('YYYY-MM-DD hh:mm:ss');
  // https://luckyyowu.tistory.com/346
  console.log(req.receivedAt + ': ', req.method, req.protocol +'://' + req.hostname + req.url);
  switch(req.method) {
  case "GET":
    console.log(req.receivedAt + ': ', req.params);
    break;
  case "POST":
    console.log(req.receivedAt + ': ', req.body);
    break;
  }
  return next();
});

/////////////////////////////////////////////////////////////////////////

const db = mysql.createConnection({
  host     : process.env.DB_HOSTNAME,
  user     : process.env.DB_USERNAME,
  password : process.env.DB_PASSWORD,
  database : process.env.DB_DATABASE
});

db.query("set time_zone='+9:00'", function (err, result) {
  if (err) {
    console.log("[mysql] Timezone (" + err + ")");
    process.exit();
  }
});

const logger = winston.createLogger({
  level: "info",
  format: combine(timestamp(), json()),
  transports: [
    new winston.transports.File({ filename: 'hancom.log', dirname: path.join(__dirname, "./logs") }),
  ],
});

//var redcli = redis.createClient();
//
//redcli.on("connect", function() {
//  console.log("You are now connected");
//  redcli.set("student", "Laylaa");
//  redcli.get('student', function(err, resp) {
//    console.log(resp);
//  });
//});

let mycache = new nodecache();

function parseReceipt(email, pf, tf, txt) {
  console.log('/usr/bin/php receipt-parser.php ' + '"' + txt + '"');
  exec('/usr/bin/php receipt-parser.php ' + '"' + txt + '"', function(err, stdout, stderr) {
    var obj = JSON.parse(stdout);
    if(obj != null) {
      logger.info(obj);
      console.log(obj);
      escpInsert (email, pf, tf, obj);
      return obj;
    }
  });
}

////////////////////////////////////////////////////////
//
// DB operation
//
function toNumber (s) {
  console.log('s',s);
  if(s == undefined) return 0;
  return parseInt(s.replace(/\,/g, ''), 10);
}

function escpInsert (email, pf, tf, obj) {
  var sql = "INSERT INTO receipt (email, name, register, tel, address, text, pdf, total, cash, card, ts) " + "values('" + email + "', '" + obj.name + "', " + "'" + obj.register + "', '" + obj.tel + "', '" + obj.address + "', '" + tf + "', '" + pf + "', " + toNumber(obj.total) + ", " + toNumber(obj.cash) + ", " + toNumber(obj.card) + ", FROM_UNIXTIME(" + moment(obj.date)/1000 + "))";
  db.query(sql, function (err, result) {
    if (err) console.error("[mysql] Insert (" + err + ") : " + sql);
  });
}

//////////////////////////////////////////////////////////////////////////////////
//
// EPSON ESC/P COMMAND
//

const ESC       =  27;  // escape code
const RESET     =  64;
const BOLD      =  69;
const UNDERLINE =  45;
const ALIGN     =  97;
const POINT     =  77;
const FONTATTR  =  38;
const COLOR     = 114;
const PAPERCUT  =  29;

function escp (data) {
    const buf = [];
    var idx = 0;

    for(i=0; i<data.length; i++) {
        switch(data[i]) {
        case 27:
            switch (data[++i]) {
            case 64:
                break;
            case 33:
            case 45:
            case 69:
            case 77:
            case 97:
            case 100:
            case 105:
            case 114:
                i += 1;
                break;
            case 29:
                idx = i - 1;
                i += 2;
                break;
            default:
                i += 1;
                break;
            }
            break;
        default:
            if(data[i] >= 32) {
                buf.push(data[i]);
            }
            else if(data[i] == 10) {
                buf.push(data[i]);
            }
            else if(data[i] == 13) {
                buf.push(data[i]);
            }
            else if(data[i] == 29) {
                idx = i;
            }
            else {
                buf.push(data[i]);
            }
        }
   }
   if(idx == 0) idx = data.length - 1;
   return  iconv.decode(Buffer.from(buf), 'euc-kr').toUpperCase();
}

function fcmMessage (To, Url) {
  var message = { 
    to: To,
    notification: {
      title: '전지영수증이 발급되었습니다.', 
      body: '---' 
    },
    data: {
      receipt: Url
    }
  };
  fcm.send(message, function(err, response){
    if (err) {
      console.log("Something has gone wrong!");
    } else {
      console.log("Successfully sent with response: ", response);
    }
  });
}

///////////////////////////////////////////////////////////////
//
// SIGN-IN (LOG-IN), SIGN-UP
//

app.post('/sign-in/', function(req, res) {
  var id      = req.body.id;
  var pwd     = req.body.pwd;
  var key     = req.body.key;
  var code    = 200;
  var message = "OK";

  var sql = "UPDATE users SET fcmkey = '" + key + "' WHERE email = '" + id + "' AND passwd = '" + pwd + "'";
  console.log (sql);

  db.query(sql, function (err, result) {
    if (result.affectedRows < 1) {
      code = 204; // no content (user)
      message = "User/ Password not found!";
    }
    if (err) {
      console.error("[mysql] Insert (" + err + ") : " + sql);
      code = 500;
      message = err.sqlMessage;
    }
    var result = {};
    result.code    = code;
    result.message = message;
    res.contentType('application/json');
    console.log(JSON.stringify(result));
    res.send(JSON.stringify(result));
  });
});

app.post('/sign-up/', function(req, res) {
  var id     = req.body.id;
  var pwd    = req.body.pwd;
  var code   = 200;
  var message = "OK";

  var sql = "INSERT INTO users (email, passwd, fcmkey, ts) " + "values('" + id + "', '" + pwd + "', ''" + ", FROM_UNIXTIME(" + moment().unix() + "))";
  console.log (sql);
  db.query(sql, function (err, result) {
    if (err) { 
      console.error("[mysql] Insert (" + err + ") : " + sql);
      code = 500;
      message = err.sqlMessage;
    }
    var result = {};
    result.code    = code;
    result.message = message;
    res.contentType('application/json');
    console.log(JSON.stringify(result));
    res.send(JSON.stringify(result));
  });
});

///////////////////////////////////////////////////////////////
//
// RECEIPT
//

app.post('/receipt/:license', function(req, res) {
  var license = req.params.license;
  var device  = new escpos.Console();
  var printer = escpos.Printer(device);

  var parser = npos.parser();
  var doc    = new pdf({
    size: [224, 600],
    margins : { // by default, all are 72
      top: 10,
      bottom:10,
      left: 10,
      right: 10
    }
  });
  var name = rand.generate(16);
  var pf  = 'pdf/' + name + '.pdf';
  var tf  = 'txt/' + name + '.txt';
  var out = fs.createWriteStream(pf);
  var txt = escp(Buffer.from(req.body.Data, 'hex'));
  doc.pipe(out);
  doc
    .font('fonts/NanumGothicCoding.ttf')
    .fontSize(9)
    .text(txt, 15, 15);
  doc.end();

  fs.writeFile(tf, txt, function (err) {
    if (err) console.log(err);
  });

  parseReceipt ('haeyun@gmail.com', pf, tf, txt);

  out.on('finish', function() {
  });
  device.open(function(error) {
    printer.buffer.write(Buffer.from(req.body.Data, 'hex'));
  });

  console.log(pf);

  //////////////////////////////////////////////////////////
  //
  // FCM (Firebase Cloud Messaging)
  //
  var value   = mycache.get(license.toString());
  if(value != undefined) {
    var sql = "SELECT * FROM users WHERE email = '" + value + "'";
    console.log(sql);
    db.query(sql, function (err, result) {
      if (err) {
        console.error("[mysql] Insert (" + err + ") : " + sql);
        res.send("");
      }
      else {
        console.log(result);
        console.log(result[0]['fcmkey']);
        fcmMessage(result[0]['fcmkey'], 'https://tric.kr/'+ pf);
        res.send(Buffer.from(printer.buffer._buffer).toString('hex'));
      }
    });
  }
  res.send("");
});

app.get('/qrcode/:id', function(req, res){
  var id     = req.params.id;
  var qrcode = rand.generateDigits(10);
  var code    = 200;
  var message = "OK";
  mycache.set(qrcode.toString(), id, TTL);

  var result = {};
  result.code    = code;
  result.message = message;
  result.id      = id;
  result.qrcode  = qrcode;
  res.contentType('application/json');
  console.log(JSON.stringify(result));
  res.send(JSON.stringify(result));
})

app.get('/qrcode/json/:license/:qrcode', function(req, res){
  var license = req.params.license;
  var qrcode  = req.params.qrcode;
  var value   = mycache.get(qrcode.toString());
  var code    = 200;
  var message = "OK";

  if(value == undefined) {
    code = 204;
    message = "Invalid QR code";
  }
  else {
    mycache.set(license.toString(), value, TTL);
  }

  var result = {};
  result.code    = code;
  result.message = message;
  res.contentType('application/json');
  console.log(JSON.stringify(result));
  res.send(JSON.stringify(result));
})


app.get('/pdf/:file', function(req, res){
  var file = req.params.file;
  var data =fs.readFileSync('./pdf/' + file);
  res.contentType("application/pdf");
  res.send(data);
})

app.get('/qrtest/:code', function(req, res){
  var code = req.params.code;
  value = mycache.get(code.toString());

  res.send('code: ' + code + '<br>' + 'value: ' + value);
})

app.get('/qrscan/:license', function(req, res){
  var license = req.params.license;
  res.render('qrscan', {license: license});
});

////////////////////////////////////////////////////////
//
// listener
//

const httpServer  = http.createServer(app);
const httpsServer = https.createServer(credentials, app);

httpServer.listen(80, () => {
  console.log('Listener: ', 'http  listening on port ' + httpport);
});

httpsServer.listen(443, () => {
  console.log('Listener: ', 'https listening on port ' + httpsport);
});

module.exports = app;

