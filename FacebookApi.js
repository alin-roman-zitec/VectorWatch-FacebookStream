var Promise = require('bluebird');

/**
 * @param oauth
 * @constructor
 */
var FacebookApi = function FacebookApi(oauth) {
    this.oauth = oauth;
};

/**
 * @param path {String}
 * @param accessToken {String}
 * @returns {Promise}
 */
FacebookApi.prototype.get = function (path, accessToken) {
    var future = Promise.defer();

    var url = 'https://graph.facebook.com/v2.4' + path;
    this.oauth.get(url, accessToken, function (err, data) {
        if (err) return future.reject(err);
        try {
            data = JSON.parse(data);
        } catch (err) {
            return future.reject(err);
        }
        future.resolve(data);
    });

    return future.promise.catch(FacebookApi.parseError);
};

FacebookApi.prototype._post = function(url, data, access_token, callback) {
    if (this.oauth._useAuthorizationHeaderForGET) {
        var headers= { Authorization: this.oauth.buildAuthHeader(access_token) };
        access_token = null;
    } else {
        headers = { };
    }
    this.oauth._request('POST', url, headers, '', access_token, callback);
};

FacebookApi.prototype._delete = function(url, data, access_token, callback) {
    if (this.oauth._useAuthorizationHeaderForGET) {
        var headers= { Authorization: this.oauth.buildAuthHeader(access_token) };
        access_token = null;
    } else {
        headers = { };
    }
    this.oauth._request('DELETE', url, headers, '', access_token, callback);
};

/**
 * @param path {String}
 * @param data {Object}
 * @param accessToken {String}
 * @returns {Promise}
 */
FacebookApi.prototype.post = function (path, data, accessToken) {
    var future = Promise.defer();

    var url = 'https://graph.facebook.com/v2.4' + path;
    this._post(url, data, accessToken, function (err, data) {
        if (err) return future.reject(err);
        try {
            data = JSON.parse(data);
        } catch (err) {
            return future.reject(err);
        }
        future.resolve(data);
    });

    return future.promise.catch(FacebookApi.parseError);
};

/**
 * @param path {String}
 * @param data {Object}
 * @param accessToken {String}
 * @returns {Promise}
 */
FacebookApi.prototype.delete = function (path, data, accessToken) {
    var future = Promise.defer();

    var url = 'https://graph.facebook.com/v2.4' + path;
    this._delete(url, data, accessToken, function (err, data) {
        if (err) return future.reject(err);
        try {
            data = JSON.parse(data);
        } catch (err) {
            return future.reject(err);
        }
        future.resolve(data);
    });

    return future.promise.catch(FacebookApi.parseError);
};

/**
 * @param pageId {Number}
 * @param accessToken {String}
 * @returns {Promise}
 */
FacebookApi.prototype.getPageCounts = function (pageId, accessToken) {
    return this.get(
        '/' + pageId + '?fields=new_like_count,unread_message_count,unread_notif_count',
        accessToken
    ).then(function(data) {
        return {
            newLikes: data.new_like_count,
            newMessages: data.unread_message_count,
            newNotifications: data.unread_notif_count
        };
    });
};

/**
 * @param accessToken {String}
 * @returns {Promise}
 */
FacebookApi.prototype.getPages = function(accessToken) {
    return this.get('/me?fields=accounts.limit(500){name}', accessToken)
    .then(function(data) {
        return (data && data.accounts && data.accounts.data) || [];
    });
};

/**
 * @param accessToken {String}
 * @returns {Promise}
 */
FacebookApi.prototype.getUserId = function(accessToken) {
    return this.get('/me?fields=id', accessToken)
        .then(function(data) {
            return data.id;
        });
};

FacebookApi.prototype.subscribePageToRTUs = function(pageId, accessToken) {
    var _this = this;
    return this.getPageAccessToken(pageId, accessToken).then(function(pageAccessToken) {
        return _this.post('/me/subscribed_apps', { id: pageId }, pageAccessToken);
    }).then(function(data) {
        return data.success;
    });
};

FacebookApi.prototype.unsubscribePageFromRTUs = function(pageId, accessToken) {
    var _this = this;
    return this.getPageAccessToken(pageId, accessToken).then(function(pageAccessToken) {
        return _this.delete('/me/subscribed_apps', { id: pageId }, pageAccessToken);
    }).then(function(data) {
        return data.success;
    });
};

FacebookApi.prototype.getPageAccessToken = function(pageId, accessToken) {
    return this.get('/' + pageId + '?fields=access_token', accessToken).then(function(data) {
        return data.access_token;
    });
};

FacebookApi.prototype.getLastPostCounts = function(account, accessToken) {
    var counts = {
        likes: 0,
        comments: 0
    };

    return this.get(
        '/' + account + '?fields=feed.limit(1){comments.limit(0).summary(1),likes.limit(0).summary(1)}',
        accessToken
    ).then(function(data) {
        if (!data.feed || !data.feed.data || !data.feed.data[0]) {
            return counts;
        }
        var post = data.feed.data[0];
        if (post.likes && post.likes.summary) {
            counts.likes = post.likes.summary.total_count || 0;
        }
        if (post.comments && post.comments.summary) {
            counts.comments = post.comments.summary.total_count || 0;
        }
        return counts;
    });
};

FacebookApi.prototype.getNextEvent = function(accessToken) {
    return this.get('/me?fields=events.limit(100){name,rsvp_status,start_time,place{name}}', accessToken).then(function(data) {
        if (!data || !data.events || !data.events.data || !data.events.data.length) {
            return null;
        }

        var events = data.events.data.filter(function(event) {
            if (['attending', 'unsure'].indexOf(event.rsvp_status) < 0) {
                return false;
            }

            return Date.now() <= (new Date(event.start_time)).getTime();
        }).sort(function(a, b) {
            return (new Date(a.start_time)).getTime() - (new Date(b.start_time)).getTime();
        });
        if (!events[0]) return null;
        var event = events[0];

        return {
            name: event.name,
            location: event.place && event.place.name,
            date: new Date(event.start_time)
        };
    });
};

FacebookApi.prototype.getPageDetails = function(pageId, accessToken) {
    return this.get('/' + pageId + '?fields=name', accessToken).then(function(data) {
        return {
            name: data && data.name
        };
    });
};

FacebookApi.prototype.getWeeklyInsights = function(objectId, insights, accessToken) {
    var aDay = 24 * 60 * 60;
    var toUnix = 0.001;
    var today = Math.floor(Date.now() / aDay * toUnix) * aDay;
    var tomorrow = today + aDay;
    var twoWeeksAgo = tomorrow - aDay  * 14;


    var path = '/' + objectId + '/insights/' + insights + '/day?since=' + twoWeeksAgo + '&until=' + tomorrow;
    return this.get(path, accessToken).then(function(data) {
        var counts = {
            thisWeek: 0,
            lastWeek: 0
        };
        var values = data && data.data && data.data[0] && data.data[0].values;
        if (!values) return counts;
        values.sort(function(a, b) { return (new Date(a.end_time)).getTime() - (new Date(b.end_time)).getTime(); });
        counts.lastWeek = values.slice(0, 7).reduce(function(sum, item) { return sum + Number(item.value); }, 0);
        counts.thisWeek = values.slice(7).reduce(function(sum, item) { return sum + Number(item.value); }, 0);

        return counts;
    });
};

FacebookApi.prototype.getPageWeeklyReach = function(pageId, accessToken) {
    return this.getWeeklyInsights(pageId, 'page_impressions_unique', accessToken);
};

FacebookApi.prototype.getPostWeeklyReach = function(pageId, accessToken) {
    return this.getWeeklyInsights(pageId, 'page_posts_impressions_unique', accessToken);
};

FacebookApi.prototype.getPageWeeklyEngagement = function(pageId, accessToken) {
    return this.getWeeklyInsights(pageId, 'page_engaged_users', accessToken);
};

FacebookApi.prototype.getPageWeeklyNewLikes = function(pageId, accessToken) {
    return this.getWeeklyInsights(pageId, 'page_fan_adds', accessToken);
};

FacebookApi.prototype.getPageClicks = function(pageId, accessToken) {
    return this.getWeeklyInsights(pageId, 'page_consumptions', accessToken);
};

FacebookApi.prototype.getPageWeeklyLikes = function(pageId, accessToken) {
    var aDay = 24 * 60 * 60;
    var toUnix = 0.001;
    var today = Math.floor(Date.now() / aDay * toUnix) * aDay;
    var tomorrow = today + aDay;
    var aWeekAgo = tomorrow - aDay  * 7;


    var path = '/' + pageId + '/insights/page_fans?since=' + aWeekAgo + '&until=' + tomorrow;
    return this.get(path, accessToken).then(function(data) {
        var counts = {
            thisWeek: 0,
            lastWeek: 0
        };
        var values = data && data.data && data.data[0] && data.data[0].values;
        if (!values || !Array.isArray(values)) return counts;
        values.sort(function(a, b) { return (new Date(a.end_time)).getTime() - (new Date(b.end_time)).getTime(); });
        counts.lastWeek = (values.shift() || {}).value || 0;
        counts.thisWeek = (values.pop() || {}).value || 0;

        return counts;
    });
};

FacebookApi.prototype.getPositiveFeedback = function(pageId, accessToken) {
    var aDay = 24 * 60 * 60;
    var toUnix = 0.001;
    var today = Math.floor(Date.now() / aDay * toUnix) * aDay;
    var tomorrow = today + aDay;
    var twoWeeksAgo = tomorrow - aDay  * 14;

    var path = '/' + pageId + '/insights/page_positive_feedback_by_type/day?since=' + twoWeeksAgo + '&until=' + tomorrow;
    return this.get(path, accessToken).then(function(data) {
        var counts = {
            thisWeek: 0,
            lastWeek: 0
        };
        var values = data && data.data && data.data[0] && data.data[0].values;
        if (!values) return counts;
        values.sort(function(a, b) { return (new Date(a.end_time)).getTime() - (new Date(b.end_time)).getTime(); });

        var sumFn = function(sumObj, item) {
            return {
                likes: Number(item.value.like) + sumObj.likes || 0,
                comments: Number(item.value.comment) + sumObj.comments || 0,
                shares: Number(item.value.link) + sumObj.shares || 0
            };
        };

        counts.lastWeek = values.slice(0, 7).reduce(sumFn, {});
        counts.thisWeek = values.slice(7).reduce(sumFn, {});

        return counts;
    });
};

function FacebookApiError(rawError) {
    this.raw = rawError;
    this.message = rawError.message;
    this.name = 'FacebookApiError';
    Error.captureStackTrace(this, FacebookApiError);
}
FacebookApiError.prototype = Object.create(Error.prototype);
FacebookApiError.prototype.getType = function() { return this.raw.type; };
FacebookApiError.prototype.getRaw = function() { return this.raw; };
FacebookApiError.prototype.constructor = FacebookApiError;

function FacebookOAuthError(rawError) {
    this.raw = rawError;
    this.message = rawError.message;
    this.name = 'FacebookOAuthError';
    Error.captureStackTrace(this, FacebookOAuthError);
}
FacebookOAuthError.prototype = Object.create(FacebookApiError.prototype);
FacebookOAuthError.prototype.constructor = FacebookOAuthError;

FacebookApi.parseError = function(err) {
    if (typeof err == 'string') {
        err = JSON.parse(err);
    }
    if (!err.error) throw err;
    if (!err.error.fbtrace_id) throw err;

    err = new FacebookApiError(err.error);
    if (err.getType() == 'OAuthException') {
        err = new FacebookOAuthError(err.getRaw());
    }

    throw err;
};

FacebookApi.FacebookApiError = FacebookApiError;
FacebookApi.FacebookOAuthError = FacebookOAuthError;

module.exports = FacebookApi;