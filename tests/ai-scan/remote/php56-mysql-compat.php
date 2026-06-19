<?php
if (!defined('MYSQL_ASSOC')) define('MYSQL_ASSOC', MYSQLI_ASSOC);
if (!defined('MYSQL_NUM')) define('MYSQL_NUM', MYSQLI_NUM);
if (!defined('MYSQL_BOTH')) define('MYSQL_BOTH', MYSQLI_BOTH);

$GLOBALS['__mysql_compat_link'] = null;

if (!function_exists('mysql_connect')) {
    function mysql_connect($host = null, $user = null, $password = null) {
        $host = $host ?: 'localhost';
        $port = 3306;
        if (strpos($host, ':') !== false) {
            list($hostOnly, $portOnly) = explode(':', $host, 2);
            $host = $hostOnly;
            $port = (int)$portOnly;
        }
        $link = @mysqli_connect($host, $user ?: '', $password ?: '', '', $port);
        if ($link) $GLOBALS['__mysql_compat_link'] = $link;
        return $link;
    }
}

if (!function_exists('mysql_select_db')) {
    function mysql_select_db($database, $link = null) {
        return mysqli_select_db($link ?: $GLOBALS['__mysql_compat_link'], $database);
    }
}

if (!function_exists('mysql_query')) {
    function mysql_query($query, $link = null) {
        return mysqli_query($link ?: $GLOBALS['__mysql_compat_link'], $query);
    }
}

if (!function_exists('mysql_fetch_array')) {
    function mysql_fetch_array($result, $type = MYSQL_BOTH) {
        return mysqli_fetch_array($result, $type);
    }
}

if (!function_exists('mysql_fetch_assoc')) {
    function mysql_fetch_assoc($result) {
        return mysqli_fetch_assoc($result);
    }
}

if (!function_exists('mysql_fetch_row')) {
    function mysql_fetch_row($result) {
        return mysqli_fetch_row($result);
    }
}

if (!function_exists('mysql_num_rows')) {
    function mysql_num_rows($result) {
        return $result ? mysqli_num_rows($result) : 0;
    }
}

if (!function_exists('mysql_affected_rows')) {
    function mysql_affected_rows($link = null) {
        return mysqli_affected_rows($link ?: $GLOBALS['__mysql_compat_link']);
    }
}

if (!function_exists('mysql_insert_id')) {
    function mysql_insert_id($link = null) {
        return mysqli_insert_id($link ?: $GLOBALS['__mysql_compat_link']);
    }
}

if (!function_exists('mysql_real_escape_string')) {
    function mysql_real_escape_string($string, $link = null) {
        return mysqli_real_escape_string($link ?: $GLOBALS['__mysql_compat_link'], $string);
    }
}

if (!function_exists('mysql_error')) {
    function mysql_error($link = null) {
        $link = $link ?: $GLOBALS['__mysql_compat_link'];
        return $link ? mysqli_error($link) : '';
    }
}

if (!function_exists('mysql_errno')) {
    function mysql_errno($link = null) {
        $link = $link ?: $GLOBALS['__mysql_compat_link'];
        return $link ? mysqli_errno($link) : 0;
    }
}

if (!function_exists('mysql_get_server_info')) {
    function mysql_get_server_info($link = null) {
        $link = $link ?: $GLOBALS['__mysql_compat_link'];
        return $link ? mysqli_get_server_info($link) : '';
    }
}

if (!function_exists('mysql_close')) {
    function mysql_close($link = null) {
        $link = $link ?: $GLOBALS['__mysql_compat_link'];
        return $link ? mysqli_close($link) : true;
    }
}

if (!function_exists('mysql_data_seek')) {
    function mysql_data_seek($result, $offset) {
        return mysqli_data_seek($result, $offset);
    }
}

if (!function_exists('mysql_result')) {
    function mysql_result($result, $row, $field = 0) {
        mysqli_data_seek($result, $row);
        $data = mysqli_fetch_array($result);
        return $data[$field] ?? null;
    }
}

if (!function_exists('mysql_free_result')) {
    function mysql_free_result($result) {
        return mysqli_free_result($result);
    }
}

if (!function_exists('mysql_fetch_object')) {
    function mysql_fetch_object($result) {
        return mysqli_fetch_object($result);
    }
}

if (!function_exists('mysql_num_fields')) {
    function mysql_num_fields($result) {
        return mysqli_num_fields($result);
    }
}

if (!function_exists('mysql_fetch_field')) {
    function mysql_fetch_field($result, $field_offset = null) {
        return $field_offset === null
            ? mysqli_fetch_field($result)
            : mysqli_fetch_field_direct($result, $field_offset);
    }
}

if (!function_exists('mysql_field_name')) {
    function mysql_field_name($result, $field_offset) {
        $field = mysqli_fetch_field_direct($result, $field_offset);
        return $field ? $field->name : false;
    }
}

if (!function_exists('mysql_unbuffered_query')) {
    function mysql_unbuffered_query($query, $link = null) {
        return mysqli_query($link ?: $GLOBALS['__mysql_compat_link'], $query, MYSQLI_USE_RESULT);
    }
}

if (!function_exists('eregi')) {
    function eregi($pattern, $string, &$regs = null) {
        return preg_match('/'.str_replace('/', '\\/', $pattern).'/i', $string, $regs);
    }
}

if (!function_exists('ereg')) {
    function ereg($pattern, $string, &$regs = null) {
        return preg_match('/'.str_replace('/', '\\/', $pattern).'/', $string, $regs);
    }
}

if (!function_exists('split')) {
    function split($pattern, $string, $limit = -1) {
        return preg_split('/'.str_replace('/', '\\/', $pattern).'/', $string, $limit);
    }
}

if (!function_exists('get_magic_quotes_gpc')) {
    function get_magic_quotes_gpc() {
        return false;
    }
}

if (!function_exists('set_magic_quotes_runtime')) {
    function set_magic_quotes_runtime($new_setting) {
        return false;
    }
}
?>
