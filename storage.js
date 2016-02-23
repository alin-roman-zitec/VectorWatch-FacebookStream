var Promise = require('bluebird');
var mysql = require('mysql');

var connection = {
    queryAsync: function() {
        return Promise.reject(new Error('Not configured.'));
    }
};

module.exports = {
    config: function(options) {
        connection = mysql.createPool(options);
        connection.queryAsync = Promise.promisify(connection.query);
    },

    associateChannelLabelWithObject: function(channelLabel, objectId) {
        return connection.queryAsync('INSERT IGNORE INTO Associations (channelLabel, objectId) VALUES (?, ?)', [channelLabel, objectId]);
    },

    getChannelLabelAssociationCountForObject: function(objectId) {
        return connection.queryAsync('SELECT COUNT(channelLabel) AS count FROM Associations WHERE objectId = ?', [objectId]).then(function(records) {
            return records[0].count;
        });
    },

    getChannelLabelAssociationsForObject: function(objectId) {
        return connection.queryAsync('SELECT channelLabel FROM Associations WHERE objectId = ?', [objectId]).then(function(records) {
            return records.map(function(record) {
                return record.channelLabel;
            });
        });
    },

    unassociateChannelLabelFromObject: function(channelLabel, objectId) {
        return connection.queryAsync('DELETE FROM Association WHERE channelLabel = ? AND objectId = ?', [channelLabel, objectId]);
    }
};