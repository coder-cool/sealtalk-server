var APIResult, Blacklist, Cache, Config, DataVersion, Friendship, Group, GroupMember, GroupSync, LoginLog, MAX_GROUP_MEMBER_COUNT, NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PORTRAIT_URI_MAX_LENGTH, PORTRAIT_URI_MIN_LENGTH, Session, User, Utility, VerificationCode, _, co, express, getToken, moment, qiniu, ref, regionMap, rongCloud, router, sequelize, validator;

var utils = require('../util/util.js');

var YunPianSMS = require('../util/sms.js'),
  sendYunPianCode = YunPianSMS.sendCode,
  YunPianErrorCodeMap = YunPianSMS.ErrorCodeMap,
  getClientIp = utils.getClientIp,
  formatRegion = utils.formatRegion;

var regionListCache;

var adminReport = require('../util/admin-report'),
  reportRegister = adminReport.reportRegister;

express = require('express');

co = require('co');

_ = require('underscore');

moment = require('moment');

rongCloud = require('rongcloud-sdk');

qiniu = require('qiniu');

Config = require('../conf');

Cache = require('../util/cache');

Session = require('../util/session');

Utility = require('../util/util').Utility;

APIResult = require('../util/util').APIResult;

var addUpdateTimeToList = require('../util/util').addUpdateTimeToList;

// ref = require('../db'), sequelize = ref[0], User = ref[1], Blacklist = ref[2], Friendship = ref[3], Group = ref[4], GroupMember = ref[5], GroupSync = ref[6], DataVersion = ref[7], VerificationCode = ref[8], LoginLog = ref[9], VerificationViolation = ref[10];
ref = require('../db')
let = {
  sequelize,
  User,
  Blacklist,
  Friendship,
  Group,
  GroupMember,
  GroupSync, 
  DataVersion, 
  VerificationCode,
  LoginLog
} = ref


// var { 
//   sequelize,
//   User, 
//   Blacklist, 
//   Friendship, 
//   Group, 
//   GroupMember, 
//   GroupSync, 
//   DataVersion, 
//   VerificationCode, 
//   LoginLog, 
//   VerificationViolation, 
//   GroupFav, 
//   GroupBulletin, 
//   GroupReceiver, 
//   ScreenStatus, 
//   GroupExitedList
// } = ref

console.log("sssss", ref)

var GroupFav = ref[11];

MAX_GROUP_MEMBER_COUNT = 500;

NICKNAME_MIN_LENGTH = 1;

NICKNAME_MAX_LENGTH = 32;

PORTRAIT_URI_MIN_LENGTH = 12;

PORTRAIT_URI_MAX_LENGTH = 256;

PASSWORD_MIN_LENGTH = 6;

PASSWORD_MAX_LENGTH = 20;

FRIENDSHIP_AGREED = 20;

FRIENDSHIP_DELETED = 30;

FRIENDSHIP_BLACK = 31; 

rongCloud.init(Config.RONGCLOUD_APP_KEY, Config.RONGCLOUD_APP_SECRET, {
  api: Config.RONGCLOUD_API_URL
});

router = express.Router();

validator = sequelize.Validator;

regionMap = {
  '86': 'zh-CN'
};

var ViolationControl = {
  getDefaultVerifi: function () {
    return {
      time: Date.now(),
      count: 0
    };
  },
  LimitedTime: Config.YUNPIAN_LIMITED_TIME || 1, // 限制小时
  LimitedCount: Config.YUNPIAN_LIMITED_COUNT || 20, // 限制次数
  check: function (ip) {
    return new Promise(function (resolve, reject) {
      VerificationViolation.findOne({
        where: {
          ip: ip
        },
        attributes: ['time', 'count']
      }).then(function (verification) {
        verification = verification ? verification.dataValues : ViolationControl.getDefaultVerifi();
        var violationCount = verification.count;
        var sendInterval = moment().subtract(ViolationControl.LimitedTime, 'h'); // 对时间的限制
        var beyondLimit = violationCount >= ViolationControl.LimitedCount;
        if (sendInterval.isBefore(verification.time) && beyondLimit) {
          return reject(YunPianErrorCodeMap.violation);
        }
        resolve();
      });
    });
  },
  update: function (ip) {
    return VerificationViolation.findOne({
      where: {
        ip: ip
      },
      attributes: ['time', 'count']
    }).then(function (verification) {
      verification = verification ? verification.dataValues : ViolationControl.getDefaultVerifi();
      verification.ip = ip;
      var sendInterval = moment().subtract(ViolationControl.LimitedTime, 'h'); // 对时间的限制
      if (!sendInterval.isBefore(verification.time)) {
        verification.time = Date.now();
        verification.count = 0;
      }
      verification.count += 1;
      return VerificationViolation.upsert(verification);
    });
  }
};

getToken = function (userId, nickname, portraitUri) {
  return new Promise(function (resolve, reject) {
    return rongCloud.user.getToken(Utility.encodeId(userId), nickname, portraitUri, function (err, resultText) {
      var result;
      if (err) {
        return reject(err);
      }
      result = JSON.parse(resultText);
      if (result.code !== 200) {
        return reject(new Error('RongCloud Server API Error Code: ' + result.code));
      }
      return User.update({
        rongCloudToken: result.token
      }, {
          where: {
            id: userId
          }
        }).then(function () {
          return resolve(result.token);
        })["catch"](function (error) {
          return reject(error);
        });
    });
  });
};

getNormalToken = function (userId, nickname, portraitUri) {
  return new Promise(function (resolve, reject) {
    rongCloud.user.getToken(userId, nickname, portraitUri, function (err, resultText) {
      var result;
      if (err) {
        return reject(err);
      }
      result = JSON.parse(resultText);
      if (result.code !== 200) {
        return reject(new Error('RongCloud Server API Error Code: ' + result.code));
      }
      resolve({token: result.token});
    });
  });
};

router.post('/send_code', function (req, res, next) {
  var phone, region;
  region = req.body.region;
  phone = req.body.phone;
  if (!validator.isMobilePhone(phone.toString(), regionMap[region])) {
    return res.status(400).send('Invalid region and phone number.');
  }
  return VerificationCode.getByPhone(region, phone).then(function (verification) {
    var code, subtraction, timeDiff;
    if (verification) {
      timeDiff = Math.floor((Date.now() - verification.updatedAt.getTime()) / 1000);
      if (req.app.get('env') === 'development') {
        subtraction = moment().subtract(5, 's');
      } else {
        subtraction = moment().subtract(1, 'm');
      }
      if (subtraction.isBefore(verification.updatedAt)) {
        return res.send(new APIResult(5000, null, 'Throttle limit exceeded.'));
      }
    }
    code = _.random(1000, 9999);
    if (req.app.get('env') === 'development') {
      return VerificationCode.upsert({
        region: region,
        phone: phone,
        sessionId: ''
      }).then(function () {
        return res.send(new APIResult(200));
      });
    } else if (Config.RONGCLOUD_SMS_REGISTER_TEMPLATE_ID !== '') {
      return rongCloud.sms.sendCode(region, phone, Config.RONGCLOUD_SMS_REGISTER_TEMPLATE_ID, function (err, resultText) {
        var result;
        if (err) {
          return next(err);
        }
        result = JSON.parse(resultText);
        if (result.code !== 200) {
          return next(new Error('RongCloud Server API Error Code: ' + result.code));
        }
        return VerificationCode.upsert({
          region: region,
          phone: phone,
          sessionId: result.sessionId
        }).then(function () {
          return res.send(new APIResult(200));
        });
      });
    }
  })["catch"](next);
});

router.post('/send_code_yp', function (req, res, next) {
  var phone = req.body.phone,
    region = req.body.region;
  console.log('+++++++')
  var ip = getClientIp(req);
  region = formatRegion(region);
  if (Config.DEBUG) {
    return Promise.resolve().then(function(){
      return res.send(new APIResult(200));
    })["catch"](next);
  }
  var newVerification = { phone: phone, region: region, sessionId: '' };
  return VerificationCode.getByPhone(region, phone).then(function (verification) {
    if (verification) {
      var timeDiff = Math.floor((Date.now() - verification.updatedAt.getTime()) / 1000);
      var momentNow = moment();
      var subtraction = momentNow.subtract(1, 'm');
      if (subtraction.isBefore(verification.updatedAt)) {
        return res.send(new APIResult(5000, null, 'Throttle limit exceeded.'));
      }
    }
    if (req.app.get('env') === 'development') {
      return VerificationCode.upsert({
        region: region,
        phone: phone,
        sessionId: 'dev'
      }).then(function () {
        return res.send(new APIResult(200));
      });
    } else {
      return ViolationControl.check(ip)
        .then(function () {
          return sendYunPianCode(region, phone);
        })
        .then(function (result) {
          newVerification.sessionId = result.sessionId;
          console.log("newVerification.sessionId>>>", newVerification.sessionId)
          return VerificationCode.upsert(newVerification).then(function () {
            res.send(new APIResult(200));
            return ViolationControl.update(ip);
          });
        }, function (err) {
          res.send(new APIResult(err.code, err, err.msg));
        });
    }
  })["catch"](next);
});

router.post('/verify_code', function (req, res, next) {
  var code, phone, region;
  phone = req.body.phone;
  region = req.body.region;
  code = req.body.code;
  return VerificationCode.getByPhone(region, phone).then(function (verification) {
    if (!verification) {
      return res.status(404).send('Unknown phone number.');
    } else if (moment().subtract(2, 'm').isAfter(verification.updatedAt)) {
      return res.send(new APIResult(2000, null, 'Verification code expired.'));
    } else if ((req.app.get('env') === 'development' || Config.RONGCLOUD_SMS_REGISTER_TEMPLATE_ID === '') && code === '9999') {
      return res.send(new APIResult(200, {
        verification_token: verification.token
      }));
    } else {
      return rongCloud.sms.verifyCode(verification.sessionId, code, function (err, resultText) {
        var errorMessage, result;
        if (err) {
          errorMessage = err.message;
          if (errorMessage === 'Unsuccessful HTTP response' || errorMessage === 'Too Many Requests' || verification.sessionId === '') {
            return res.status(err.status).send(errorMessage);
          } else {
            return next(err);
          }
        }
        result = JSON.parse(resultText);
        if (result.code !== 200) {
          return next(new Error('RongCloud Server API Error Code: ' + result.code));
        }
        if (result.success) {
          return res.send(new APIResult(200, {
            verification_token: verification.token
          }));
        } else {
          return res.send(new APIResult(1000, null, 'Invalid verification code.'));
        }
      });
    }
  })["catch"](next);
});

router.post('/verify_code_yp', function (req, res, next) {
  var phone = req.body.phone,
    region = req.body.region,
    code = req.body.code,
    region = formatRegion(region);
  return VerificationCode.getByPhone(region, phone).then(function (verification) {
    if (!verification) {
      return res.status(404).send('Unknown phone number.');
    } else if (moment().subtract(2, 'm').isAfter(verification.updatedAt)) {
      return res.send(new APIResult(2000, null, 'Verification code expired.'));
    } else if ((req.app.get('env') === 'development') && code === '9999') {
      return res.send(new APIResult(200, {
        verification_token: verification.token
      }));
    }
    var success = verification.sessionId == code;
    if (success) {
      return res.send(new APIResult(200, {
        verification_token: verification.token
      }));
    } else {
      return res.send(new APIResult(1000, null, 'Invalid verification code.'));
    }
  })["catch"](next);
});

router.post('/verify_code_yp_t', function (req, res, next) {
  var phone = req.body.phone,
    region = req.body.region,
    code = req.body.code,
    userId = req.body.key,
    region = formatRegion(region),
    name = "",
    portraitUri = "";
  if (Config.DEBUG) {
    return getNormalToken(userId, name, portraitUri).then(function (result) {
      return res.send(new APIResult(200, Utility.encodeResults(result)));
    })["catch"](next);
  }
  return VerificationCode.getByPhone(region, phone).then(function (verification) {
    if (!verification) {
      return res.status(404).send('Unknown phone number.');
    } else if (moment().subtract(2, 'm').isAfter(verification.updatedAt)) {
      return res.send(new APIResult(2000, null, 'Verification code expired.'));
    }
    var success = verification.sessionId == code;
    if (success) {
      return getNormalToken(userId, name, portraitUri).then(function (result) {
        return res.send(new APIResult(200, Utility.encodeResults(result)));
      });
    } else {
      return res.send(new APIResult(1000, null, 'Invalid verification code.'));
    }
  })["catch"](next);
});

router.get('/regionlist', function (req, res, next) {

  if (regionListCache && utils.isArray(regionListCache)) {
    return res.send(new APIResult(200, regionListCache));
  }

  YunPianSMS.getRegionList().then(function (regionList) {
    regionListCache = regionList;
    return res.send(new APIResult(200, regionList));
  }, function (err) {
    res.send(new APIResult(1000, null, 'Invalid region list.'));
  })["catch"](next);;
});

router.post('/check_phone_available', function (req, res, next) {
  var phone, region;
  region = req.body.region;
  phone = req.body.phone;
  var regionName = regionMap[region];
  // 此处只使用已有国家验证方式, 其他通过 sendCode 验证, sendCode 不通过则返回错误码 3102
  if (regionName && !validator.isMobilePhone(phone.toString(), regionName)) {
    return res.status(400).send('Invalid region and phone number.');
  }
  return User.checkPhoneAvailable(region, phone).then(function (result) {
    if (result) {
      return res.send(new APIResult(200, true));
    } else {
      return res.send(new APIResult(200, false, 'Phone number has already existed.'));
    }
  })["catch"](next);
});

router.post('/register', function (req, res, next) {
  var nickname, password, verificationToken;
  nickname = Utility.xss(req.body.nickname, NICKNAME_MAX_LENGTH);
  password = req.body.password;
  verificationToken = req.body.verification_token;
  if (password.indexOf(' ') > 0) {
    return res.status(400).send('Password must have no space.');
  }
  if (!validator.isLength(nickname, NICKNAME_MIN_LENGTH, NICKNAME_MAX_LENGTH)) {
    return res.status(400).send('Length of nickname invalid.');
  }
  if (!validator.isLength(password, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)) {
    return res.status(400).send('Length of password invalid.');
  }
  if (!validator.isUUID(verificationToken)) {
    return res.status(400).send('Invalid verification_token.');
  }
  return VerificationCode.getByToken(verificationToken).then(function (verification) {
    if (!verification) {
      return res.status(404).send('Unknown verification_token.');
    }
    return User.checkPhoneAvailable(verification.region, verification.phone).then(function (result) {
      var hash, salt;
      if (result) {
        salt = Utility.random(1000, 9999);
        hash = Utility.hash(password, salt);
        return sequelize.transaction(function (t) {
          return User.create({
            nickname: nickname,
            region: verification.region,
            phone: verification.phone,
            passwordHash: hash,
            passwordSalt: salt.toString()
          }, {
              transaction: t
            }).then(function (user) {
              return DataVersion.create({
                userId: user.id,
                transaction: t
              }).then(function () {
                Session.setAuthCookie(res, user.id);
                Session.setNicknameToCache(user.id, nickname);
                var isDebug = req.app.get('env') !== 'production';
                reportRegister(verification.phone, verification.region, isDebug);
                return res.send(new APIResult(200, Utility.encodeResults({
                  id: user.id
                })));
              });
            });
        });
      } else {
        return res.status(400).send('Phone number has already existed.');
      }
    });
  })["catch"](next);
});

router.post('/login', function (req, res, next) {
  var password, phone, region;
  region = req.body.region;
  phone = req.body.phone;
  password = req.body.password;
  var regionName = regionMap[region];
  if (regionName && !validator.isMobilePhone(phone, regionName)) {
    return res.status(400).send('Invalid region and phone number.');
  }
  return User.findOne({
    where: {
      region: region,
      phone: phone
    },
    attributes: ['id', 'passwordHash', 'passwordSalt', 'nickname', 'portraitUri', 'rongCloudToken']
  }).then(function (user) {
    var errorMessage, passwordHash;
    errorMessage = 'Phone number not found.';
    if (!user) {
      return res.send(new APIResult(1000, null, errorMessage));
    } else {
      passwordHash = Utility.hash(password, user.passwordSalt);
      if (passwordHash !== user.passwordHash) {
        return res.send(new APIResult(1001, null, 'Wrong password.'));
      }
      Session.setAuthCookie(res, user.id);
      Session.setNicknameToCache(user.id, user.nickname);
      GroupMember.findAll({
        where: {
          memberId: user.id
        },
        attributes: [],
        include: {
          model: Group,
          where: {
            deletedAt: null
          },
          attributes: ['id', 'name']
        }
      }).then(function (groups) {
        var groupIdNamePairs;
        Utility.log('Sync groups: %j', groups);
        groupIdNamePairs = {};
        groups.forEach(function (group) {
          return groupIdNamePairs[Utility.encodeId(group.group.id)] = group.group.name;
        });
        Utility.log('Sync groups: %j', groupIdNamePairs);
        return rongCloud.group.sync(Utility.encodeId(user.id), groupIdNamePairs, function (err, resultText) {
          if (err) {
            return Utility.logError('Error sync user\'s group list failed: %s', err);
          }
        });
      })["catch"](function (error) {
        return Utility.logError('Sync groups error: ', error);
      });
      if (user.rongCloudToken === '') {
        /**
          if (req.app.get('env') === 'development') {
          return res.send(new APIResult(200, Utility.encodeResults({
            id: user.id,
            token: 'fake token'
          })));
        }*/
        return getToken(user.id, user.nickname, user.portraitUri).then(function (token) {
          return res.send(new APIResult(200, Utility.encodeResults({
            id: user.id,
            token: token
          })));
        });
      } else {
        return res.send(new APIResult(200, Utility.encodeResults({
          id: user.id,
          token: user.rongCloudToken
        })));
      }
    }
  })["catch"](next);
});

router.post('/logout', function (req, res) {
  res.clearCookie(Config.AUTH_COOKIE_NAME);
  return res.send(new APIResult(200));
});

router.post('/reset_password', function (req, res, next) {
  var password, verificationToken;
  password = req.body.password;
  verificationToken = req.body.verification_token;
  if (password.indexOf(' ') !== -1) {
    return res.status(400).send('Password must have no space.');
  }
  if (!validator.isLength(password, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)) {
    return res.status(400).send('Length of password invalid.');
  }
  if (!validator.isUUID(verificationToken)) {
    return res.status(400).send('Invalid verification_token.');
  }
  return VerificationCode.getByToken(verificationToken).then(function (verification) {
    var hash, salt;
    if (!verification) {
      return res.status(404).send('Unknown verification_token.');
    }
    salt = _.random(1000, 9999);
    hash = Utility.hash(password, salt);
    return User.update({
      passwordHash: hash,
      passwordSalt: salt.toString()
    }, {
        where: {
          region: verification.region,
          phone: verification.phone
        }
      }).then(function () {
        return res.send(new APIResult(200));
      });
  })["catch"](next);
});

router.post('/change_password', function (req, res, next) {
  var newPassword, oldPassword;
  newPassword = req.body.newPassword;
  oldPassword = req.body.oldPassword;
  if (newPassword.indexOf(' ') !== -1) {
    return res.status(400).send('New password must have no space.');
  }
  if (!validator.isLength(newPassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)) {
    return res.status(400).send('Invalid new password length.');
  }
  return User.findById(Session.getCurrentUserId(req, {
    attributes: ['id', 'passwordHash', 'passwordSalt']
  })).then(function (user) {
    var newHash, newSalt, oldHash;
    oldHash = Utility.hash(oldPassword, user.passwordSalt);
    if (oldHash !== user.passwordHash) {
      return res.send(new APIResult(1000, null, 'Wrong old password.'));
    }
    newSalt = _.random(1000, 9999);
    newHash = Utility.hash(newPassword, newSalt);
    return user.update({
      passwordHash: newHash,
      passwordSalt: newSalt.toString()
    }).then(function () {
      return res.send(new APIResult(200));
    });
  })["catch"](next);
});

router.post('/set_nickname', function (req, res, next) {
  var currentUserId, nickname, timestamp;
  nickname = Utility.xss(req.body.nickname, NICKNAME_MAX_LENGTH);
  if (!validator.isLength(nickname, NICKNAME_MIN_LENGTH, NICKNAME_MAX_LENGTH)) {
    return res.status(400).send('Invalid nickname length.');
  }
  currentUserId = Session.getCurrentUserId(req);
  timestamp = Date.now();
  return User.update({
    nickname: nickname,
    timestamp: timestamp
  }, {
      where: {
        id: currentUserId
      }
    }).then(function () {
      rongCloud.user.refresh(Utility.encodeId(currentUserId), nickname, null, function (err, resultText) {
        var result;
        if (err) {
          Utility.logError('RongCloud Server API Error: ', err.message);
        }
        result = JSON.parse(resultText);
        if (result.code !== 200) {
          return Utility.logError('RongCloud Server API Error Code: ', result.code);
        }
      });
      Session.setNicknameToCache(currentUserId, nickname);
      return Promise.all([DataVersion.updateUserVersion(currentUserId, timestamp), DataVersion.updateAllFriendshipVersion(currentUserId, timestamp)]).then(function () {
        Cache.del("user_" + currentUserId);
        Cache.del("friendship_profile_user_" + currentUserId);
        Friendship.findAll({
          where: {
            userId: currentUserId
          },
          attributes: ['friendId']
        }).then(function (friends) {
          return friends.forEach(function (friend) {
            return Cache.del("friendship_all_" + friend.friendId);
          });
        });
        GroupMember.findAll({
          where: {
            memberId: currentUserId,
            isDeleted: false
          },
          attributes: ['groupId']
        }).then(function (groupMembers) {
          return groupMembers.forEach(function (groupMember) {
            return Cache.del("group_members_" + groupMember.groupId);
          });
        });
        return res.send(new APIResult(200));
      });
    })["catch"](next);
});

router.post('/set_portrait_uri', function (req, res, next) {
  var currentUserId, portraitUri, timestamp;
  portraitUri = Utility.xss(req.body.portraitUri, PORTRAIT_URI_MAX_LENGTH);
  if (!validator.isURL(portraitUri, {
    protocols: ['http', 'https'],
    require_protocol: true
  })) {
    return res.status(400).send('Invalid portraitUri format.');
  }
  if (!validator.isLength(portraitUri, PORTRAIT_URI_MIN_LENGTH, PORTRAIT_URI_MAX_LENGTH)) {
    return res.status(400).send('Invalid portraitUri length.');
  }
  currentUserId = Session.getCurrentUserId(req);
  timestamp = Date.now();
  return User.update({
    portraitUri: portraitUri,
    timestamp: timestamp
  }, {
      where: {
        id: currentUserId
      }
    }).then(function () {
      rongCloud.user.refresh(Utility.encodeId(currentUserId), null, portraitUri, function (err, resultText) {
        var result;
        if (err) {
          Utility.logError('RongCloud Server API Error: ', err.message);
        }
        result = JSON.parse(resultText);
        if (result.code !== 200) {
          return Utility.logError('RongCloud Server API Error Code: ', result.code);
        }
      });
      return Promise.all([DataVersion.updateUserVersion(currentUserId, timestamp), DataVersion.updateAllFriendshipVersion(currentUserId, timestamp)]).then(function () {
        Cache.del("user_" + currentUserId);
        Cache.del("friendship_profile_user_" + currentUserId);
        Friendship.findAll({
          where: {
            userId: currentUserId
          },
          attributes: ['friendId']
        }).then(function (friends) {
          return friends.forEach(function (friend) {
            return Cache.del("friendship_all_" + friend.friendId);
          });
        });
        GroupMember.findAll({
          where: {
            memberId: currentUserId,
            isDeleted: false
          },
          attributes: ['groupId']
        }).then(function (groupMembers) {
          return groupMembers.forEach(function (groupMember) {
            return Cache.del("group_members_" + groupMember.groupId);
          });
        });
        return res.send(new APIResult(200));
      });
    })["catch"](next);
});

router.post('/add_to_blacklist', function (req, res, next) {
  var currentUserId, encodedFriendId, friendId, timestamp;
  friendId = req.body.friendId;
  encodedFriendId = req.body.encodedFriendId;
  currentUserId = Session.getCurrentUserId(req);
  timestamp = Date.now();
  return User.checkUserExists(friendId).then(function (result) {
    if (result) {
      return rongCloud.user.blacklist.add(Utility.encodeId(currentUserId), encodedFriendId, function (err, resultText) {
        if (err) {
          return next(err);
        } else {
          return Blacklist.upsert({
            userId: currentUserId,
            friendId: friendId,
            status: true,
            timestamp: timestamp
          }).then(function () {
            return DataVersion.updateBlacklistVersion(currentUserId, timestamp).then(function () {
              Cache.del("user_blacklist_" + currentUserId);
              return Friendship.update({
                status: FRIENDSHIP_BLACK,
                displayName: '',
                message: '',
                timestamp: timestamp
              }, {
                where: {
                  userId: currentUserId,
                  friendId: friendId,
                  status: FRIENDSHIP_AGREED
                }
              });
            }).then(function () {
              Cache.del("friendship_profile_displayName_" + currentUserId + "_" + friendId);
              Cache.del("friendship_profile_user_" + currentUserId + "_" + friendId);
              Cache.del("friendship_all_" + currentUserId);
              Cache.del("friendship_all_" + friendId);
              return res.send(new APIResult(200));
            });
          });
        }
      });
    } else {
      return res.status(404).send('friendId is not an available userId.');
    }
  })["catch"](next);
});

router.post('/remove_from_blacklist', function (req, res, next) {
  var currentUserId, encodedFriendId, friendId, timestamp;
  friendId = req.body.friendId;
  encodedFriendId = req.body.encodedFriendId;
  currentUserId = Session.getCurrentUserId(req);
  timestamp = Date.now();
  return rongCloud.user.blacklist.remove(Utility.encodeId(currentUserId), encodedFriendId, function (err, resultText) {
    if (err) {
      return next(err);
    } else {
      return Blacklist.update({
        status: false,
        timestamp: timestamp
      }, {
          where: {
            userId: currentUserId,
            friendId: friendId
          }
        }).then(function () {
          return DataVersion.updateBlacklistVersion(currentUserId, timestamp).then(function () {
            Cache.del("user_blacklist_" + currentUserId);
            Friendship.update({
              status: FRIENDSHIP_AGREED
            },{
              where: {
                userId: currentUserId,
                friendId: friendId,
                status: FRIENDSHIP_BLACK
              }
            }).then(function (result) {
              console.log('result--remove black',result);
              if(result) {
                console.log('result--remove black',result);
                Cache.del("friendship_profile_displayName_" + currentUserId + "_" + friendId);
                Cache.del("friendship_profile_user_" + currentUserId + "_" + friendId);
                Cache.del("friendship_all_" + currentUserId);
                Cache.del("friendship_all_" + friendId);
                return res.send(new APIResult(200));
              }
            }).catch(function(err) {
              console.log(err);
              return res.send(new APIResult(200));
            })
          })["catch"](next);
        });
    }
  });
});

router.post('/upload_contacts', function (req, res, next) {
  var contacts;
  contacts = req.body;
  return res.status(404).send('Not implements.');
});

router.get('/get_token', function (req, res, next) {
  return User.findById(Session.getCurrentUserId(req, {
    attributes: ['id', 'nickname', 'portraitUri']
  })).then(function (user) {
    return getToken(user.id, user.nickname, user.portraitUri).then(function (token) {
      return res.send(new APIResult(200, Utility.encodeResults({
        userId: user.id,
        token: token
      }, 'userId')));
    });
  })["catch"](next);
});

router.get('/get_image_token', function (req, res, next) {
  var putPolicy, token;
  qiniu.conf.ACCESS_KEY = Config.QINIU_ACCESS_KEY;
  qiniu.conf.SECRET_KEY = Config.QINIU_SECRET_KEY;
  putPolicy = new qiniu.rs.PutPolicy(Config.QINIU_BUCKET_NAME);
  token = putPolicy.token();
  return res.send(new APIResult(200, {
    target: 'qiniu',
    domain: Config.QINIU_BUCKET_DOMAIN,
    token: token
  }));
});

router.get('/get_sms_img_code', function (req, res, next) {
  rongCloud.sms.getImgCode(Config.RONGCLOUD_APP_KEY, function (err, resultText) {
    var result;
    if (err) {
      return next(err);
    }
    result = JSON.parse(resultText);
    if (result.code !== 200) {
      return next(new Error('RongCloud Server API Error Code: ' + result.code));
    }
  });
  return res.send(new APIResult(200, {
    url: result.url,
    verifyId: result.verifyId
  }));
});

router.get('/blacklist', function (req, res, next) {
  var currentUserId, timestamp;
  currentUserId = Session.getCurrentUserId(req);
  timestamp = Date.now();
  return Cache.get("user_blacklist_" + currentUserId).then(function (blacklist) {
    if (blacklist) {
      return res.send(new APIResult(200, blacklist));
    } else {
      return Blacklist.findAll({
        where: {
          userId: currentUserId,
          friendId: {
            $ne: 0
          },
          status: true
        },
        attributes: [],
        include: {
          model: User,
          attributes: ['id', 'nickname', 'portraitUri', 'gender', 'stAccount', 'phone','updatedAt']
        }
      }).then(function (dbBlacklist) {
        var results;
        rongCloud.user.blacklist.query(Utility.encodeId(currentUserId), function (err, resultText) {
          var dbBlacklistUserIds, hasDirtyData, result, serverBlacklistUserIds;
          if (err) {
            return Utility.logError('Error: request server blacklist failed: %s', err);
          } else {
            result = JSON.parse(resultText);
            if (result.code === 200) {
              hasDirtyData = false;
              serverBlacklistUserIds = result.users;
              dbBlacklistUserIds = dbBlacklist.map(function (blacklist) {
                if (blacklist.user) {
                  return blacklist.user.id;
                } else {
                  hasDirtyData = true;
                  return null;
                }
              });
              if (hasDirtyData) {
                Utility.log('Dirty blacklist data %j', dbBlacklist);
              }
              serverBlacklistUserIds.forEach(function (encodedUserId) {
                var userId;
                userId = Utility.decodeIds(encodedUserId);
                if (dbBlacklistUserIds.indexOf(userId) === -1) {
                  return Blacklist.create({
                    userId: Utility.decodeIds(currentUserId),
                    friendId: Utility.decodeIds(userId),
                    status: true,
                    timestamp: timestamp
                  }).then(function () {
                    Utility.log('Sync: fix user blacklist, add %s -> %s from db.', currentUserId, userId);
                    return DataVersion.updateBlacklistVersion(currentUserId, timestamp);
                  })["catch"](function () { });
                }
              });
              return dbBlacklistUserIds.forEach(function (userId) {
                if (userId && serverBlacklistUserIds.indexOf(Utility.encodeId(userId)) === -1) {
                  return Blacklist.update({
                    status: false,
                    timestamp: timestamp
                  }, {
                      where: {
                        userId: Utility.decodeIds(currentUserId),
                        friendId: Utility.decodeIds(userId)
                      }
                    }).then(function () {
                      Utility.log('Sync: fix user blacklist, remove %s -> %s from db.', currentUserId, userId);
                      return DataVersion.updateBlacklistVersion(Utility.decodeIds(currentUserId), timestamp);
                    }, function (err) {
                      console.log('black list error', err);
                    });
                }
              });
            }
          }
        });
        results = Utility.encodeResults(dbBlacklist, [['user', 'id']]);
        results = addUpdateTimeToList(results, {
          objName: 'user'
        });
        Cache.set("user_blacklist_" + currentUserId, results);
        return res.send(new APIResult(200, results));
      });
    }
  })["catch"](next);
});

router.get('/groups', function (req, res, next) {
  var currentUserId;
  currentUserId = Session.getCurrentUserId(req);
  return Cache.get("user_groups_" + currentUserId).then(function (groups) {
    if (groups) {
      return res.send(new APIResult(200, groups));
    } else {
      return GroupMember.findAll({
        where: {
          memberId: currentUserId
        },
        attributes: ['role'],
        include: [
          {
            model: Group,
            attributes: ['id', 'name', 'portraitUri', 'creatorId', 'memberCount', 'maxMemberCount','isMute','certiStatus']
          }
        ]
      }).then(function (groups) {
        var results;
        results = Utility.encodeResults(groups, [['group', 'id'], ['group', 'creatorId']]);
        Cache.set("user_groups_" + currentUserId, results);
        return res.send(new APIResult(200, results));
      });
    }
  })["catch"](next);
});

router.get('/sync/:version', function (req, res, next) {
  var blacklist, currentUserId, friends, groupMembers, groups, maxVersions, user, version;
  version = req.params.version;
  if (!validator.isInt(version)) {
    return res.status(400).send('Version parameter is not integer.');
  }
  user = blacklist = friends = groups = groupMembers = null;
  maxVersions = [];
  currentUserId = Session.getCurrentUserId(req);
  return DataVersion.findById(currentUserId).then(function (dataVersion) {
    return co(function* () {
      var groupIds, group_members;
      if (dataVersion.userVersion > version) {
        user = (yield User.findById(currentUserId, {
          attributes: ['id', 'nickname', 'portraitUri', 'timestamp']
        }));
      }
      if (dataVersion.blacklistVersion > version) {
        blacklist = (yield Blacklist.findAll({
          where: {
            userId: currentUserId,
            timestamp: {
              $gt: version
            }
          },
          attributes: ['friendId', 'status', 'timestamp'],
          include: [
            {
              model: User,
              attributes: ['id', 'nickname', 'portraitUri']
            }
          ]
        }));
      }
      if (dataVersion.friendshipVersion > version) {
        friends = (yield Friendship.findAll({
          where: {
            userId: currentUserId,
            timestamp: {
              $gt: version
            }
          },
          attributes: ['friendId', 'displayName', 'status', 'timestamp'],
          include: [
            {
              model: User,
              attributes: ['id', 'nickname', 'portraitUri']
            }
          ]
        }));
      }
      if (dataVersion.groupVersion > version) {
        groups = (yield GroupMember.findAll({
          where: {
            memberId: currentUserId,
            timestamp: {
              $gt: version
            }
          },
          attributes: ['groupId', 'displayName', 'role', 'isDeleted'],
          include: [
            {
              model: Group,
              attributes: ['id', 'name', 'portraitUri', 'timestamp']
            }
          ]
        }));
      }
      if (groups) {
        groupIds = groups.map(function (group) {
          return group.group.id;
        });
      } else {
        groupIds = [];
      }
      if (dataVersion.groupVersion > version) {
        groupMembers = (yield GroupMember.findAll({
          where: {
            groupId: {
              $in: groupIds
            },
            timestamp: {
              $gt: version
            }
          },
          attributes: ['groupId', 'memberId', 'displayName', 'role', 'isDeleted', 'timestamp'],
          include: [
            {
              model: User,
              attributes: ['id', 'nickname', 'portraitUri']
            }
          ]
        }));
      }
      if (user) {
        maxVersions.push(user.timestamp);
      }
      if (blacklist) {
        maxVersions.push(_.max(blacklist, function (item) {
          return item.timestamp;
        }).timestamp);
      }
      if (friends) {
        maxVersions.push(_.max(friends, function (item) {
          return item.timestamp;
        }).timestamp);
      }
      if (groups) {
        maxVersions.push(_.max(groups, function (item) {
          return item.group.timestamp;
        }).group.timestamp);
      }
      if (groupMembers) {
        maxVersions.push(_.max(groupMembers, function (item) {
          return item.timestamp;
        }).timestamp);
      }
      if (blacklist === null) {
        blacklist = [];
      }
      if (friends === null) {
        friends = [];
      }
      if (groups === null) {
        groups = [];
      }
      if (group_members === null) {
        group_members = [];
      }
      Utility.log('maxVersions: %j', maxVersions);
      return res.send(new APIResult(200, {
        version: _.max(maxVersions),
        user: user,
        blacklist: blacklist,
        friends: friends,
        groups: groups,
        group_members: groupMembers
      }));
    });
  })["catch"](next);
});

router.get('/batch', function (req, res, next) {
  var ids;
  ids = req.query.id;
  if (!Array.isArray(ids)) {
    ids = [ids];
  }
  ids = Utility.decodeIds(ids);
  return User.findAll({
    where: {
      id: {
        $in: ids
      }
    },
    attributes: ['id', 'nickname', 'portraitUri']
  }).then(function (users) {
    return res.send(new APIResult(200, Utility.encodeResults(users)));
  })["catch"](next);
});

router.get('/favgroups', function (req, res, next) {
  var currentUserId = Session.getCurrentUserId(req),
    limit = req.query.limit,
    offset = req.query.offset;
  return GroupFav.getGroups(currentUserId, limit, offset).then(function (results) {
    return res.send(new APIResult(200, results));
  })['catch'](next);
});



router.get('/find/:region/:phone', function (req, res, next) {
  var phone, region;
  region = req.params.region;
  phone = req.params.phone;
  var regionName = regionMap[region];
  if (regionName && !validator.isMobilePhone(phone, regionName)) {
    return res.status(400).send('Invalid region and phone number.');
  }
  return User.findOne({
    where: {
      region: region,
      phone: phone
    },
    attributes: ['id', 'nickname', 'portraitUri']
  }).then(function (user) {
    if (!user) {
      return res.status(404).send('Unknown user.');
    }
    return res.send(new APIResult(200, Utility.encodeResults(user)));
  })["catch"](next);
});

// 为调试短信, 增加测试环境删除 user 接口
router.post('/delete_new', function (req, res, next) {
  var region = req.body.region;
  var phone = req.body.phone;
  var isDevelopment = req.app.get('env') === 'development';
  if (isDevelopment) {
    console.log({
      phone: phone,
      region: region
    })
    return User.destroy({
      where: {
        phone: phone,
        region: region
      },
      force: true
    }).then(function (result) {
      console.log(result);
      return res.send(new APIResult(200));
    })["catch"](next);;
  } else {
    return res.status(400).send('Only development environment support');
  }
});

//设置性别
router.post('/set_gender', function (req, res, next) {
  var gender, currentUserId;
  gender = req.body.gender;
  currentUserId = Session.getCurrentUserId(req);
  
  if(['male','female'].indexOf(gender) == -1){
    return res.status(400).send('Parameter error.');
  }
  return User.update({
    gender: gender
  }, {
    where: {
      id: currentUserId
    }
  }).then(function() {
    console.log('------');
    return res.send(new APIResult(200));
  }, function(err){
    console.log('err', err);
  })["catch"](next);
});

//设置 SealTalk 号
router.post('/set_st_account', function (req, res, next) {
  var stAccount, currentUserId;
  stAccount = req.body.stAccount;
  currentUserId = Session.getCurrentUserId(req);
  if(stAccount.length < 6 || stAccount.length > 20) {
    return res.status(400).send('Incorrect parameter length.');
  }
  if(!stAccount.match(/^[a-zA-Z][a-zA-Z0-9_-]*$/)) {
    return res.status(400).send('Not letter beginning or invalid symbol.');
  }
  User.findOne({
    where: {
      stAccount: stAccount
    }
  }).then(function(user) {
    if(user) {
      return res.send(new APIResult(1000)); 
    }
    return User.update({
      stAccount: stAccount
    }, {
      where: {
        id: currentUserId
      }
    }).then(function() {
      res.send(new APIResult(200));
    })["catch"](next);
  })
})

//个人隐私设置
router.post('/set_privacy', function (req, res, next) {
  var currentUserId,phoneVerify, stSearchVerify, friVerify, groupVerify;
  currentUserId = Session.getCurrentUserId(req);
  phoneVerify = req.body.phoneVerify;
  stSearchVerify = req.body.stSearchVerify;
  friVerify = req.body.friVerify;
  groupVerify = req.body.groupVerify;
  console.log(phoneVerify == undefined)
  if(phoneVerify == undefined && stSearchVerify == undefined && friVerify == undefined && groupVerify == undefined){
    return res.status(400).send('Parameter is empty.');
  }
  for(var key in req.body) {
   if(req.body[key]){
     if([0,1].indexOf(req.body[key]) == -1) {
      return res.status(400).send('Illegal parameter .');
     }
   }
  }
  return User.findOne({
    where: {
      id: currentUserId
    },
    attributes: ['phoneVerify','stSearchVerify','friVerify','groupVerify']
  }).then(function (result) {
    return User.update({
      phoneVerify: phoneVerify == undefined ? result.phoneVerify : phoneVerify,
      stSearchVerify: stSearchVerify == undefined ? result.stSearchVerify : stSearchVerify,
      friVerify: friVerify == undefined ? result.friVerify : friVerify,
      groupVerify: groupVerify == undefined ? result.groupVerify : groupVerify
      }, {
        where: {
          id: currentUserId
        }
      }).then(function() {
        res.send(new APIResult(200));
      })
  })["catch"](next);
})

// 获取个人隐私
router.get('/get_privacy', function (req, res, next) {
  var currentUserId = Session.getCurrentUserId(req);
  User.findOne({
    where: {
      id: currentUserId
    },
    attributes: ['id', 'phoneVerify', 'stSearchVerify', 'friVerify', 'groupVerify']
  }).then(function(user) {
    res.send(new APIResult(200, Utility.encodeResults(user)));
    // res.send(new APIResult(200,user));
  })["catch"](next);
})

// 通过 手机号 或 SealTalk 号查用户
router.get('/find_user', function (req, res, next) {
  var phone, region, stAccount;
  region = req.query.region;
  phone = req.query.phone;
  stAccount = req.query.st_account;
  console.log(region == undefined && phone == undefined && stAccount == undefined);
  if(region == undefined && phone == undefined && stAccount == undefined){
    return res.status(400).send('Parameter is empty.');
  }
  if(phone) {
    var regionName = regionMap[region];
    if (regionName && !validator.isMobilePhone(phone, regionName)) {
      return res.status(400).send('Invalid region and phone number.');
    }
    return User.findOne({
      where: {
        region: region,
        phone: phone
      },
      attributes: ['id', 'nickname','gender', 'portraitUri', 'stAccount', 'phoneVerify']
    }).then(function (user) {
      console.log(user)
      if (!user || user.phoneVerify == 0) {
        return res.status(404).send('Unknown user.');
      }
      return res.send(new APIResult(200, Utility.encodeResults(user)));
    })["catch"](next);
  }else {
    console.log(stAccount)
    return User.findOne({
      where: {
        stAccount: stAccount
      },
      attributes: ['id', 'nickname','gender', 'portraitUri', 'stAccount', 'stSearchVerify']
    }).then(function (user) {
      if (!user || user.stSearchVerify == 0) {
        return res.status(404).send('Unknown user.');
      }
      return res.send(new APIResult(200, Utility.encodeResults(user)));
    })
  }
  
});

router.post('/set_poke', function(req, res, next) {
  var currentUserId = Session.getCurrentUserId(req);
  var pokeStatus = req.body.pokeStatus;
  if([0,1].indexOf(pokeStatus) == -1) {
    return res.status(400).send('Illegal parameter .');
   }
  return User.update({
    pokeStatus: pokeStatus
  }, {
      where: {
        id: currentUserId
      }
    }).then(function () {
      res.send(new APIResult(200));
    })["catch"](next)
})

router.get('/get_poke', function(req, res, next) {
  var currentUserId = Session.getCurrentUserId(req);
  User.findOne({
    where: {
      id: currentUserId
    },
    attributes: ['pokeStatus']
  }).then(function(user) {
    res.send(new APIResult(200, Utility.encodeResults(user)));
  })["catch"](next);
})

router.get('/:id', function (req, res, next) {
  var userId;
  userId = req.params.id;
  userId = Utility.decodeIds(userId);
  // return Cache.get("user_" + userId).then(function (user) {
    // if (user) { //2.1.0 可直接修改 gender stAccount Cache 无法快速更新
    //   console.log('---',user);
    //   return res.send(new APIResult(200, user));
    // } else {
    //   return User.findById(userId, {
    //     attributes: ['id', 'nickname', 'portraitUri','gender','stAccount','phone']
    //   }).then(function (user) {
    //     var results;
    //     if (!user) {
    //       return res.status(404).send('Unknown user.');
    //     }
    //     results = Utility.encodeResults(user);
    //     Cache.set("user_" + userId, results);
    //     return res.send(new APIResult(200, results));
    //   });
    // }
  // })
  return User.findById(userId, {
        attributes: ['id', 'nickname', 'portraitUri','gender','stAccount','phone']
      }).then(function (user) {
        var results;
        if (!user) {
          return res.status(404).send('Unknown user.');
        }
        results = Utility.encodeResults(user);
        Cache.set("user_" + userId, results);
        return res.send(new APIResult(200, results));
      })["catch"](next);;
});
module.exports = router;
