var path = require('path'),
	async = require('async'),
	xml2js = require('xml2js'),
	net = require('net'),
	fs  = require('fs'),
	spawn = require('child_process').spawn,
	exec = require('child_process').exec,
	__self;

//############## MODULE INTERFACE ################//
function Android(sdkPath) {
	__self = this;
	this.paths = {
		adb: path.join(sdkPath, 'platform-tools', 'adb'),
		android: path.join(sdkPath, 'tools', 'android'),
		ddms: path.join(sdkPath, 'tools', 'ddms'),
		emulator: path.join(sdkPath, 'tools', 'emulator'),
		sdk: sdkPath
	};

	this.adb = {
		restart: adbRestart,
		devices: adbDevices,
		installApp: adbInstallApp,
		runApp: adbRunApp
	}

	this.avd = {
		exists: avdExists,
		running: avdRunning,
		create: avdCreate,
		start: avdStart,
		getSerial: avdGetSerial
	}

	this.getClassNameFromManifest = getClassNameFromManifest;
};
module.exports = Android;

//############## PRIVATE FUNCTIONS ######################//
var adbRestart = function(callback) {
	async.series([
		// kill any running adb server
		// TODO: sometimes even the kill-server call hangs. We probably need to kill the adb
		//       process to ensure this works after a certain period of time. 
		//       win32: tskill adb
		//       linux & darwin: killall adb
		function(asyncCallback) {
			exec(__self.paths.adb + ' kill-server', function() { asyncCallback(); });
		},
		// start the adb server
		function(asyncCallback) {
			exec(__self.paths.adb + ' start-server', function() { asyncCallback(); });
		}
	],
	function(err, result) {
		if (callback) { callback(err); } 
	});
};

var adbDevices = function(callback) {
	exec(__self.paths.adb + ' devices', function(err, stdout, stderr) {
		if (err !== null) {
			callback(err);
		} else {
			var devices = [],
			    matches,
			    items;

			// parse the output of `adb devices` to find a list of
			// all connected AVDs and devices
		 	stdout.split('\n').forEach(function(line) {
		 		if (matches = line.match(/^\s*([^\s]+)\s+([^\s]+)\s*$/)) {
		 			var device = {
		 				serial:matches[1], 
		 				status:matches[2]
		 			};
		 			if (items = device.serial.match(/^emulator\-(\d+)$/)) {
		 				device.type = 'emulator';
		 				device.port = items[1];
		 			} else {
		 				device.type = 'device';
		 			}
		 			devices.push(device);
		 		}
		 	});

		 	// construct a parallel set of function to get the avd name
		 	// of all running emulators via telnet
		 	var functions = [];
		 	devices.forEach(function(device) {
		 		if (device.type === 'emulator') {
			 		functions.push(function(parallelCallback) {
			 			getAvdNameWithDevice(device, function() {
			 				parallelCallback();
			 			});
			 		});
			 	}
		 	});
		 	async.parallel(functions, function(err, result) {
		 		callback(null, devices);
		 	});
		}
	});
};

var adbInstallApp = function(apk, serial, callback) {
	exec(__self.paths.adb + ' -s ' + serial + ' wait-for-device install -r ' + '"' + apk + '"', function(err, stdout, stderr) {
		callback(err);
	});
};

var adbRunApp = function(serial, appid, className, callback) {
	var appField = appid + '/' + appid + className;

	var maxTries = 30;
	var wait = 2000;
	var tries = 0;
	var waitForDevice = function() {
		tries++;
		if (tries >= maxTries) {
			callback('Timeout waiting for device to get ready for app launch');
		}
		exec(__self.paths.adb + ' -s ' + serial + ' shell ps | grep android.process.acore', function(err, stdout, stderr) {
			if (stdout.indexOf('android.process.acore') !== -1) {
				exec(__self.paths.adb + ' -s ' + serial + ' shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ' + appField, function(err, stdout, stderr) {
					callback(err);
				});
			} else {
				setTimeout(waitForDevice, wait);
			}
		});
	};
	setTimeout(waitForDevice, wait);
};

var avdExists = function(avdName, callback) {
	path.exists(getAndroidAvdPath(avdName + '.ini'), callback);
};

var avdRunning = function(avdName, callback) {
	var isRunning = false,
		serial = null;
	adbDevices(function(err, devices) {
		if (err) {
			callback(false);
		} else {
			devices.forEach(function(device) {
                if (device.name === avdName) {
                    isRunning = true;
                    serial = device.serial;
                }
            });
            callback(isRunning, serial);
		}
	});
};

var avdCreate = function(avdName, targetId, skin, callback) { 
	exec('echo no | ' + __self.paths.android + ' create avd -n ' + avdName + ' -t ' + targetId + ' -s ' + skin, function(err, stdout, stderr) {
		callback(err);
	});
};

var avdStart = function(avdName, callback, logCallback) {
	// TODO: How do I get the android emulator to launch in the background and 
	//       not take over the command line? Ampersand doesn't seem to be
	//       working.
	spawn(__self.paths.emulator, ['-avd', avdName, '-no-boot-anim']);
	
	if (callback) {
		var maxTries = 5;
		var wait = 2000;
		var tries = 0;

		var lookForSerial = function() {
			tries++;
			if (tries >= maxTries) {
				callback(null);
				return;
			}
			logCallback('Try #' + tries + ' to find serial number for AVD "' + avdName + '"...');
			avdGetSerial(avdName, function(serial) {
				if (serial === null) {
					setTimeout(lookForSerial, wait);
				} else {
					callback(serial);
				}
			});
		};
		setTimeout(lookForSerial, wait);
	}
};

var avdGetSerial = function(avdName, callback) {
	var serial = null;
	adbDevices(function(err, devices) {
		devices.forEach(function(device) {
			if (device.name === avdName) {
				serial = device.serial;
			}
		});
		callback(serial);
	});
};

var getClassNameFromManifest = function(manifestPath, callback) {
	var className = null;
	var parser = new xml2js.Parser({
        explicitArray:true
    });

    fs.readFile(manifestPath, function(err, data) {
        if (err) { callback(err); return; }
        parser.parseString(data, function (err, result) {
        	if (err) { callback(err); return; }
            var acts = result['application'][0]['activity'];
            acts.forEach(function(act) {
                var intents = act['intent-filter']; 
                if (intents) {
                    intents.forEach(function(intent) {
                        try {
                            if (intent['action'][0]['@']['android:name'] === 'android.intent.action.MAIN') {
                                intent['category'].forEach(function(category) {
                                    if (category['@'] && 
                                        category['@']['android:name'] == 'android.intent.category.LAUNCHER') {
                                        className = act['@']['android:name'];
                                    }
                                });
                            }
                        } catch (e) {}
                    });
                }
            });
            callback(null, className);
        });
    });
};

//############## HELPERS #####################//
var getAndroidAvdPath = function(avdName) {
	var avdPath = '';
    switch (process.platform) {
        case 'darwin':
        case 'linux':
            avdPath = path.join(process.env.HOME, '.android', 'avd');
            break;
        case 'win32':
            avdPath = path.join(process.env.USERPROFILE, '.android', 'avd');
            break;
        default:
            logger.error('Unsupported platform "' + process.platform + '"');
            return null;
    }
    return avdName ? path.join(avdPath, avdName) : avdPath;
};

var getAvdNameWithPort = function(port, callback) {
	var avdNamePattern = /OK\s+(.+?)\s+OK/m;
	var avdName = null;
	var allData = '';

	var client = net.connect(port, function() { 
        client.write('avd name\r\n');
    });
    client.on('data', function(data) {
    	allData += data.toString();
    	if (/\r\n$/.test(data)) {
    		client.end();
    	}
    });
    client.on('end', function() {
    	if (matches = allData.match(avdNamePattern)) {
    		avdName = matches[1];
    	} 
        callback(avdName);
    });
};

var getAvdNameWithDevice = function(device, callback) {
	getAvdNameWithPort(device.port, function(name) {
		device.name = name;
		callback();
	});
}