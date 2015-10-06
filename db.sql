CREATE TABLE `Auth` (
  `key` varchar(100) NOT NULL,
  `value` varchar(5000) DEFAULT NULL,
  `count` int(11) NOT NULL DEFAULT '1',
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE `Settings` (
  `key` varchar(100) NOT NULL,
  `value` varchar(5000) DEFAULT NULL,
  `count` int(11) NOT NULL DEFAULT '1',
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
