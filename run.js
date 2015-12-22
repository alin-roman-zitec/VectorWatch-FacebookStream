var Promise = require('bluebird'),
    vectorWatch = require('stream-dev-tools'),
    express = require('express'),
    app = express(),
    http = require('http'),
    moment = require('moment'),
    bodyParser = require('body-parser');


var updateIntervalInMinutes = 15;

var configJSON = {
    streamUID: process.env.STREAM_UID,
    token: process.env.VECTOR_TOKEN,

    auth: {
        protocol: 'OAuth',
        version: '2.0',
        accessTokenUrl: 'https://graph.facebook.com/oauth/access_token',
        authorizeUrl: 'https://www.facebook.com/dialog/oauth?response_type=code&scope=manage_pages,read_insights,read_page_mailboxes,user_events,user_posts',
        callbackUrl: 'http://vectorwatch-srv.cloudapp.net/facebook-stream/',
        clientId: process.env.FB_APPID,
        clientSecret: process.env.FB_SECRET
    },

    database: {
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'FacebookStream'
    }
};



var vectorStream = vectorWatch.createStreamNode(configJSON);
app.use('/facebook-stream/push', bodyParser.urlencoded({ extended: true }));
app.use('/facebook-stream/push', bodyParser.json());
app.get('/facebook-stream/push', function(req, res) {
    if (req.param('hub.verify_token') == 'iacuceapa') {
        if (req.param('hub.mode') == 'subscribe') {
            res.status(200).send(req.param('hub.challenge'));
            return;
        }
    }
    res.status(400).send();
});
app.post('/facebook-stream/push', function(req, res) {
    res.status(200).send('OK');

    var entries = [];
    req.body.entry.forEach(function(entry) {
        var fields = req.body.object == 'user' ? entry.changed_fields : entry.changes;
        fields.forEach(function(field) {
            if (typeof field == 'string') {
                field = { field: field };
            }

            entries.push({
                id: entry.id,
                time: entry.time,
                field: field.field,
                value: field.value
            });
        });
    });
    entries.sort(function(a, b) {
        return a.time - b.time;
    });

    entries.forEach(function(entry) {
        if (req.body.object == 'user') {
            handleUserPush(entry);
        } else if (req.body.object == 'page') {
            handlePagePush(entry);
        }
    })
});
app.use('/facebook-stream', vectorStream.getMiddleware());

var OAuth2 = require('oauth').OAuth2;
var FacebookApi = require('./FacebookApi.js');
var facebookApi = new FacebookApi(new OAuth2(
    configJSON.auth.clientId,
    configJSON.auth.clientSecret
));

var getAccessTokenForState = function(state) {
    var future = Promise.defer();

    vectorStream.getAuthTokensForState(state, function(err, authTokens) {
        if (err) return future.reject(err);
        future.resolve(authTokens && authTokens.access_token);
    });

    return future.promise;
};

var getStreamDataForState = function(state, accessToken) {
    if (!state) {
        return Promise.reject(new Error('Invalid state.'));
    }
    var accessTokenPromise;
    if (accessToken) {
        accessTokenPromise = Promise.resolve(accessToken);
    } else {
        accessTokenPromise = getAccessTokenForState(state);
    }
    var account = state.Account;
    var from = state['Display From'];
    var option = state['Display Option'];


    return accessTokenPromise.then(function(accessToken) {
        if (from == 'LAST_POST') {
            return facebookApi.getLastPostCounts(account, accessToken).then(function(counts){
                return '\ue02f ' + counts.likes + ' \ue02e ' + counts.comments;
            });
        }

        if (from == 'NEXT_EVENT') {
            if (account != 'me') {
                return 'N/A';
            }

            return facebookApi.getNextEvent(accessToken).then(function(event) {
                if (!event) {
                    return 'N/A';
                }

                var lines = [event.name];
                if (event.location) lines.push('\ue021 ' + event.location);
                var then = moment(event.date);
                if (then.isSame(new Date(), 'day')) {
                    lines.push('\ue02b '+ then.format('h:mm a'));
                } else {
                    lines.push('\ue02b ' + then.format('MMM Do YY'));
                }
                lines.push('\ue02c ' + then.fromNow(true) + ' left');

                return lines.join('\n');
            });
        }

        if (account == 'me') {
            // from this point the account can't be 'me'
            return 'N/A';
        }

        if (from == 'NOTIFICATIONS') {
            return facebookApi.getPageCounts(account, accessToken).then(function(counts) {
                return '\ue02f ' + counts.newLikes + ' \ue031 ' + counts.newMessages + ' \ue03b ' + counts.newNotifications;
            });
        }

        if (from == 'INSIGHTS') {
            var formatWeeklyInsights = function(icon) {
                return function(counts) {
                    var percent = 0;
                    if (counts.lastWeek != counts.thisWeek) {
                        percent = (counts.thisWeek - counts.lastWeek) / Math.max(counts.thisWeek, counts.lastWeek);
                    }

                    var sign = percent == 0 ? '' : (percent < 0 ? '\u0039' : '\ue022');
                    percent = Math.abs(Math.round(percent * 1000) / 10);
                    return icon + ' ' + counts.thisWeek + ' ' + sign + percent + '%';
                };
            };

            if (option == 'REACH') {
                return Promise.join(
                    facebookApi.getPageWeeklyReach(account, accessToken).then(formatWeeklyInsights('\ue03c Total')),
                    facebookApi.getPostWeeklyReach(account, accessToken).then(formatWeeklyInsights('\ue034 Post Reach')),
                    function(pageReach, postReach) {
                        return [pageReach, postReach].join('\n');
                    }
                );
            } else if (option == 'ENGAGEMENT') {
                return Promise.join(
                    facebookApi.getPageWeeklyEngagement(account, accessToken).then(formatWeeklyInsights('\ue036')),
                    facebookApi.getPageClicks(account, accessToken).then(formatWeeklyInsights('\ue037')),
                    facebookApi.getPositiveFeedback(account, accessToken),
                    function(engagement, clicks, feedback) {
                        var feedbackInversed = {};
                        for (var period in feedback) {
                            for (var prop in feedback[period]) {
                                if (!feedbackInversed[prop]) {
                                    feedbackInversed[prop] = {};
                                }
                                feedbackInversed[prop][period] = feedback[period][prop];
                            }
                        }
                        return [
                            engagement,
                            clicks,
                            formatWeeklyInsights('\ue02f')(feedbackInversed.likes),
                            formatWeeklyInsights('\ue02e')(feedbackInversed.comments),
                            formatWeeklyInsights('\ue030')(feedbackInversed.shares)
                        ].join('\n');
                    }
                );
            } else if (option == 'LIKES') {
                return Promise.join(
                    facebookApi.getPageWeeklyLikes(account, accessToken).then(formatWeeklyInsights('\ue02f Total ')),
                    facebookApi.getPageWeeklyNewLikes(account, accessToken).then(formatWeeklyInsights('\ue02f This week ')),
                    function (total, thisWeek) {
                        return [total, thisWeek].join('\n');
                    }
                );
            }
        }

        if (from == 'DETAILS') {
            return facebookApi.getPageDetails(account, accessToken).then(function(details) {
                return details.name;
            });
        }

        return 'N/A';
    });
};

var eligibleForPageRTUs = function(settings) {
    var account = settings.Account;
    var from = settings['Display From'];
    return account != 'me' && (from == 'LAST_POST' || from == 'NOTIFICATIONS');
};

vectorStream.registerSettings = function(resolve, reject, settings, authTokens) {
    if (!authTokens) {
        return reject(new Error('Invalid auth supplied.'), 901);
    }

    if (eligibleForPageRTUs(settings)) {
        var storageKey = 'pageid_' + settings.Account;
        vectorStream.stateStorage.retrieve(storageKey, function(err, association) {
            if (err) return console.error('Could not retrieve pageId-channelLabels associations', err.stack || err);

            var callback = function(err) {
                if (err) return console.error('Could not store pageId-channelLabels associations', err.stack || err);
            };

            if (!association) {
                facebookApi.subscribePageToRTUs(settings.Account, authTokens.access_token).then(function() {
                    association = [settings.channelLabel];
                    vectorStream.stateStorage.store(storageKey, association, callback);
                }).catch(function(err) {
                    console.error('Could not subscribe page to RTUs', err.stack || err);
                });
            } else {
                association.push(settings.channelLabel);
                association = association.filter(function(value, index, self) {
                    return self.indexOf(value) === index;
                });
                vectorStream.stateStorage.replace(storageKey, association, callback);
            }
        });
    } else if (settings.Account == 'me') {
        facebookApi.getUserId(authTokens.access_token).then(function(userId) {
            var storageKey = 'userid_' + userId;
            vectorStream.stateStorage.retrieve(storageKey, function(err, association) {
                if (err) return console.error('Could not retrieve userId-channelLabels associations', err.stack || err);

                var callback = function(err) {
                    if (err) return console.error('Could not store userId-channelLabels associations', err.stack || err);
                };

                if (!association) {
                    association = [settings.channelLabel];
                    vectorStream.stateStorage.store(storageKey, association, callback);
                } else {
                    association.push(settings.channelLabel);
                    association = association.filter(function(value, index, self) {
                        return self.indexOf(value) === index;
                    });
                    vectorStream.stateStorage.replace(storageKey, association, callback);
                }
            });
        }).catch(function(err) {
            console.error('Could not get userId', err.stack || err);
        });
    }

    // In parallel, we generate the stream data and send it back to the user
    getStreamDataForState(settings, authTokens.access_token).then(function(data) {
        resolve(data);
    }).catch(FacebookApi.FacebookOAuthError, function(err) {
        reject(err, 901);
    }).catch(function(err) {
        reject(err);
    });
};

vectorStream.unregisterSettings = function(settings) {
    if (eligibleForPageRTUs(settings)) {
        var storageKey = 'pageid_' + settings.Account;
        vectorStream.stateStorage.retrieve(storageKey, function (err, association) {
            if (err) return console.error('Could not retrieve pageId-channelLabels associations', err.stack || err);
            if (!association) return;
            var index = association.indexOf(settings.Account);
            if (index < 0) return;

            var callback = function (err) {
                if (err) return console.error('Coult not remove or update pageId-channelLabels associations', err.stack || err);
            };

            association.splice(index, 1);
            if (association.length == 0) {
                facebookApi.unsubscribePageFromRTUs(settings.Account);
                vectorStream.stateStorage.remove(storageKey, callback);
            } else {
                vectorStream.stateStorage.replace(storageKey, association, callback);
            }
        });
    }
};

vectorStream.requestConfig = function(resolve, reject, authTokens) {
    if (!authTokens) {
        return reject(new Error('Invalid auth tokens.'), 901);
    }

    facebookApi.getPages(authTokens.access_token).then(function(pages) {
        var fbPages = pages.map(function (item) {
            return {
                name: item.name,
                value: item.id
            };
        });
        fbPages.unshift({
            name: 'My Profile',
            value: 'me'
        });

        resolve({
            renderOptions: {
                Account: {
                    type: 'INPUT_LIST_STRICT',
                    hint: 'Select your profile or one of your pages to display information from.',
                    order: 0,
                    dataType: 'STATIC'
                },
                'Display From': {
                    type: 'GRID_LAYOUT',
                    hint: 'Select the option you want to display information from.',
                    order: 1,
                    dataType: 'DYNAMIC',
                    asYouType: false,
                    minChars: 0
                },
                'Display Option': {
                    type: 'GRID_LAYOUT',
                    hint: 'Select the information you want to display.',
                    order: 2,
                    dataType: 'DYNAMIC',
                    asYouType: false,
                    minChars: 0
                }
            },
            defaults: {
                Account: { value: 'me' },
                'Display From': { value: 'LAST_POST' },
                'Display Option': { value: 'LIKES' }
            },
            settings: {
                Account: fbPages,
                'Display From': [
                    { name: 'Latest Post', value: 'LAST_POST' },
                    { name: 'Notifications', value: 'NOTIFICATIONS_BAR' },
                    { name: 'Insights', value: 'INSIGHTS' }
                ],
                'Display Option': [
                    { name: 'Total Likes', value: 'LIKES' },
                    { name: 'New Likes', value: 'NEW_LIKES' },
                    { name: 'Reach', value: 'REACH' },
                    { name: 'Engagement', value: 'ENGAGEMENT' }
                ]
            }
        });
    }).catch(FacebookApi.FacebookOAuthError, function(err) {
        reject(err, 901);
    }).catch(function(err) {
        reject(err);
    });
};

vectorStream.requestOptions = function(resolve, reject, settingName, value, state/*, authTokens*/) {
    var account = state.Account;
    var from = state['Display From'];

    if (settingName == 'Display From') {
        if (account == 'me') {
            resolve([
                { name: 'Latest Post', value: 'LAST_POST' },
                { name: 'Upcoming Event', value: 'NEXT_EVENT' }
            ]);
        } else {
            resolve([
                { name: 'Latest Post', value: 'LAST_POST' },
                { name: 'Notifications', value: 'NOTIFICATIONS' },
                { name: 'Insights', value: 'INSIGHTS' },
                { name: 'Page Name', value: 'DETAILS' }
            ]);
        }
    } else if (settingName == 'Display Option') {
        if (from == 'LAST_POST') {
            resolve([]);
        } else if (from == 'NEXT_EVENT') {
            resolve([]);
        } else if (from == 'NOTIFICATIONS') {
            resolve([]);
        } else if (from == 'INSIGHTS') {
            resolve([
                { name: 'Likes', value: 'LIKES' },
                { name: 'Reach', value: 'REACH' },
                { name: 'Engagement', value: 'ENGAGEMENT' }
            ]);
        } else if (from == 'DETAILS') {
            resolve([]);
        } else {
            reject(new Error('Invalid "Display From" value.'));
        }
    } else {
        reject(new Error('Invalid settingName value.'));
    }
};


setInterval(function() {
    vectorStream.retrieveSettings(function(states) {
        for (var channelLabel in states) {
            (function(state) {
                if (!state) return;

                getStreamDataForState(state).then(function(value) {
                    vectorStream.push(state, value, 0.1);
                }).catch(FacebookApi.FacebookOAuthError, function(err) {
                    vectorStream.authTokensForStateExpired(state);
                }).catch(function(err) {
                    console.error('Could not get stream data for state.', err.stack || err);
                });
            })(states[channelLabel]);
        }
    }, function(err) {
        console.error('Could not fetch settings from database.', err.stack || err);
    });
}, updateIntervalInMinutes * 60 * 1000);


function handleUserPush(entry) {
    if (entry.field != 'feed') {
        return;
    }

    var storageKey = 'userid_' + entry.id;
    vectorStream.stateStorage.retrieve(storageKey, function(err, association) {
        if (err) return console.error('Could not retrieve userId-channelLabels associations', err.stack || err);
        if (!association) return;

        association.forEach(function(channelLabel) {
            vectorStream.stateStorage.retrieve(channelLabel, function(err, state) {
                if (err) return console.error('Could not retrieve state', err.stack || err);
                getStreamDataForState(state).then(function(value) {
                    vectorStream.push(state, value, 0.1);
                }).catch(function(err) {
                    console.error('Could not get stream data for state', err.stack || err);
                });
            });
        });
    });
}

function handlePagePush(entry) {
    if (entry.field != 'conversations' || entry.field != 'feed') {
        return;
    }

    var storageKey = 'pageid_' + entry.id;
    vectorStream.stateStorage.retrieve(storageKey, function(err, association) {
        if (err) return console.error('Could not retrieve pageId-channelLabels associations', err.stack || err);
        if (!association) return;

        association.forEach(function(channelLabel) {
            vectorStream.stateStorage.retrieve(channelLabel, function(err, state) {
                if (err) return console.error('Could not retrieve state', err.stack || err);
                getStreamDataForState(state).then(function(value) {
                    vectorStream.push(state, value, 0.1);
                }).catch(function(err) {
                    console.error('Could not get stream data for state', err.stack || err);
                });
            });
        });
    });
}


http.createServer(app).listen(8080, function() {
    console.log('Non-secure server started.');
});