var Promise = require('bluebird'),
    express = require('express'),
    app = express(),
    http = require('http'),
    moment = require('moment'),
    bodyParser = require('body-parser'),
    VectorWatch = require('vectorwatch-sdk'),
    OAuth2Provider = require('vectorwatch-authprovider-oauth2'),
    storage = require('./storage.js'),
    MySQLStorageProvider = require('vectorwatch-storageprovider-mysql');

var dbSettings = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'NewFacebookStream'
};

storage.config(dbSettings);
var storageProvider = new MySQLStorageProvider(dbSettings);
var authProvider = new OAuth2Provider(storageProvider, {
    clientId: process.env.FB_APPID,
    clientSecret: process.env.FB_SECRET,

    accessTokenUrl: 'https://graph.facebook.com/oauth/access_token',
    authorizeUrl: 'https://www.facebook.com/dialog/oauth?response_type=code&scope=manage_pages,read_insights,read_page_mailboxes,user_events,user_posts',
    callbackUrl: 'http://vectorwatch-srv.cloudapp.net/facebook-stream/'
});
var vectorWatch = new VectorWatch({
    streamUID: process.env.STREAM_UID,
    token: process.env.VECTOR_TOKEN
});
vectorWatch.setStorageProvider(storageProvider);
vectorWatch.setAuthProvider(authProvider);


var updateIntervalInMinutes = 15;


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
    if (req.body.object != 'user' && req.body.object != 'page') {
        return;
    }

    var entries = [];
    req.body.entry.forEach(function(entry) {
        var fields = req.body.object == 'user' ? entry.changed_fields : entry.changes;
        fields.forEach(function(field) {
            if (typeof field == 'string') {
                field = { field: field };
            }

            if (field.field != 'conversations' && field.field != 'feed') {
                return;
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

    entries.forEach(handleRealTimeUpdate);
});
app.use('/facebook-stream/callback', vectorWatch.getMiddleware());

var OAuth2 = require('oauth').OAuth2;
var FacebookApi = require('./FacebookApi.js');
var facebookApi = new FacebookApi(new OAuth2(
    process.env.FB_APPID,
    process.env.FB_SECRET
));


var getStreamDataForState = function(channelLabel, userSettings, authTokens) {
    var accessTokenPromise = Promise.resolve(authTokens.access_token);
    var account = userSettings.Account;
    var from = userSettings['Display From'];
    var option = userSettings['Display Option'];

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
                // todo: display the event date in it's timezone
                //if (then.isSame(new Date(), 'day')) {
                //    lines.push('\ue02b '+ then.format('h:mm a'));
                //} else {
                //    lines.push('\ue02b ' + then.format('MMM Do YY'));
                //}
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


vectorWatch.on('subscribe', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) {
            return response.sendInvalidAuthTokens();
        }

        var channelLabel = event.getChannelLabel();
        var userSettings = event.getUserSettings().toObject();

        if (eligibleForPageRTUs(userSettings)) {
            storage.getChannelLabelAssociationCountForObject(userSettings.Account).then(function(associations) {
                if (!associations) {
                    return facebookApi.subscribePageToRTUs(userSettings.Account, authTokens.access_token);
                }
            }).then(function() {
                return storage.associateChannelLabelWithObject(channelLabel, userSettings.Account);
            }).catch(function(err) {
                // log this error
            });
        } else if (userSettings.Account == 'me') {
            facebookApi.getUserId(authTokens.access_token).then(function(userId) {
                return storage.associateChannelLabelWithObject(channelLabel, userId);
            }).catch(function(err) {
                // log this error
            });
        }

        getStreamDataForState(channelLabel, userSettings, authTokens).then(function(data) {
            response.setValue(data);
            response.send();
        }).catch(FacebookApi.FacebookOAuthError, function(err) {
            response.sendInvalidAuthTokens();
        }).catch(function(err) {
            response.sendBadRequestError(err.message);
        });
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});

vectorWatch.on('unsubscribe', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) {
            return response.sendInvalidAuthTokens();
        }

        var channelLabel = event.getChannelLabel();
        var userSettings = event.getUserSettings().toObject();

        if (eligibleForPageRTUs(userSettings)) {
            storage.unassociateChannelLabelFromObject(channelLabel, userSettings.Account).then(function() {
                return storage.getChannelLabelAssociationCountForObject(userSettings.Account);
            }).then(function(associations) {
                if (!associations) {
                    return facebookApi.unsubscribePageFromRTUs(userSettings.Account, authTokens.access_token);
                }
            }).catch(function(err) {
                // log this error
            });
        } else if (userSettings.Account == 'me') {
            facebookApi.getUserId(authTokens.access_token).then(function(userId) {
                return storage.unassociateChannelLabelFromObject(channelLabel, userId);
            }).catch(function(err) {
                // log this error
            });
        }

        response.send();
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});


vectorWatch.on('config', function(event, response) {
    event.getAuthTokensAsync().then(function(authTokens) {
        if (!authTokens) {
            return response.sendInvalidAuthTokens();
        }

        facebookApi.getPages(authTokens.access_token).then(function(pages) {
            var accountSetting = response.createAutocomplete('Account')
                .setHint('Select your profile or one of your pages to display information from.');

            accountSetting.addOption('My Profile', 'me');
            pages.forEach(function(page) {
                accountSetting.addOption(page.name, page.id);
            });

            response.createGridList('Display From')
                .setHint('Select the option you want to display information from.')
                .setDynamic();

            response.createGridList('Display Option')
                .setHint('Select the information you want to display.')
                .setDynamic();

            response.send();
        }).catch(FacebookApi.FacebookOAuthError, function(err) {
            response.sendInvalidAuthTokens();
        }).catch(function(err) {
            response.sendBadRequestError(err.message);
        });
    }).catch(function(err) {
        response.sendInvalidAuthTokens();
    });
});


vectorWatch.on('options', function(event, response) {
    var userSettings = event.getUserSettings().toObject();
    var settingName = event.getSettingName();

    if (settingName == 'Display From') {
        response.addOption('Latest Post', 'LAST_POST');

        if (userSettings['Account'] == 'me') {
            response.addOption('Upcoming Event', 'NEXT_EVENT');
        } else {
            response.addOption('Notifications', 'NOTIFICATIONS');
            response.addOption('Insights', 'INSIGHTS');
            response.addOption('Page Name', 'DETAILS');
        }
    } else if (settingName == 'Display Option') {
        if (userSettings['Display From'] == 'INSIGHTS') {
            response.addOption('Likes', 'LIKES');
            response.addOption('Reach', 'REACH');
            response.addOption('Engagement', 'ENGAGEMENT');
        }
    }

    response.send();
});


setInterval(function() {
    storageProvider.getAllUserSettingsAsync().then(function(records) {
        records.forEach(function(record) {
            var userSettings = record.userSettings;
            var channelLabel = record.channelLabel;
            var authTokens = record.authTokens;

            getStreamDataForState(channelLabel, userSettings, authTokens).then(function(value) {
                vectorWatch.pushStreamValue(channelLabel, value, 1000);
            }).catch(FacebookApi.FacebookOAuthError, function(err) {
                vectorWatch.pushInvalidAuthTokens(channelLabel);
            }).catch(function(err) {
                // log this error
            });
        });
    }).catch(function(err) {
        // log this error
    });
}, updateIntervalInMinutes * 60 * 1000);


function handleRealTimeUpdate(entry) {
    storage.getChannelLabelAssociationsForObject(entry.id).then(function(channelLabels) {
        channelLabels.forEach(function(channelLabel) {
            storageProvider.getUserSettingsAsync(channelLabel).then(function(record) {
                var userSettings = record.userSettings;
                var channelLabel = record.channelLabel;
                var authTokens = record.authTokens;

                getStreamDataForState(channelLabel, userSettings, authTokens).then(function(value) {
                    vectorWatch.pushStreamValue(channelLabel, value, 1000);
                }).catch(FacebookApi.FacebookOAuthError, function(err) {
                    vectorWatch.pushInvalidAuthTokens(channelLabel);
                }).catch(function(err) {
                    // log this error
                });
            }).catch(function(err) {
                // log this error
            });
        });
    }).catch(function(err) {
        // log this error
    });
}

http.createServer(app).listen(process.env.PORT || 8080, function() {
    console.log('Non-secure server started.');
});