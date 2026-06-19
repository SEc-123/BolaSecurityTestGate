<?php
function get_site_config($parentid = 1) {
    $config = array(
        'site_url' => '',
        'site_name' => 'Traceability Security Test Target',
        'timezone' => '0',
        'time_format' => 'Y-m-d H:i:s',
        'site_lang' => 'zh_cn',
        'site_themes' => 'default',
        'agent_themes' => 'agent',
        'manage_themes' => '../themes/manage',
        'yzm_status' => '1',
        'page_title' => '',
        'page_keywords' => 'traceability,anti-counterfeit',
        'page_desc' => 'Remote BSTG traceability test target',
        'notices' => 'Enter an anti-counterfeit traceability code.',
        'notice_1' => 'Valid traceability code: {{bianhao}}. Product: {{product}}.',
        'notice_2' => 'Valid traceability code: {{bianhao}}. Product: {{product}}. Hits: {{hits}}.',
        'notice_3' => 'Traceability code {{bianhao}} was not found.',
        'notice_4' => 'Traceability code {{bianhao}} has exceeded the allowed query count.',
        'list_num' => '100',
        'com_name' => 'BSTG Remote Target',
        'fwm_max_so' => '5',
        'fwm_view' => 'yes',
        'agent_view' => 'yes',
        'cp_view' => 'yes',
        'lc_view' => 'yes',
        'dldj' => '1,2,3,4,5',
        'AppID' => '',
        'AppSecret' => '',
    );

    $parentid = (int)$parentid;
    $result = @mysql_query("SELECT code, code_value FROM tgs_config WHERE parentid IN (1, $parentid)");
    if ($result) {
        while ($row = @mysql_fetch_array($result, MYSQL_ASSOC)) {
            if (isset($row['code']) && $row['code'] !== '') {
                $config[$row['code']] = isset($row['code_value']) ? $row['code_value'] : '';
            }
        }
    }

    foreach ($config as $key => $value) {
        if ($value === null) {
            $config[$key] = '';
        }
    }
    if ($config['site_lang'] === '') $config['site_lang'] = 'zh_cn';
    if ($config['site_themes'] === '') $config['site_themes'] = 'default';
    if ($config['manage_themes'] === '') $config['manage_themes'] = '../themes/manage';
    if ($config['dldj'] === '') $config['dldj'] = '1,2,3,4,5';

    return $config;
}

function unstrreplace($value) {
    return html_entity_decode((string)$value, ENT_QUOTES, 'UTF-8');
}

function genRandomString($length = 6, $type = 0) {
    $length = max(1, (int)$length);
    $sets = array(
        0 => '0123456789',
        1 => 'abcdefghijklmnopqrstuvwxyz',
        2 => '0123456789',
        3 => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        4 => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    );
    $chars = isset($sets[(int)$type]) ? $sets[(int)$type] : $sets[4];
    $out = '';
    $max = strlen($chars) - 1;
    for ($i = 0; $i < $length; $i++) {
        $out .= $chars[random_int(0, $max)];
    }
    return $out;
}

function str_cut($string, $length, $dot = '...') {
    $string = (string)$string;
    $length = (int)$length;
    if ($length <= 0 || mb_strlen($string, 'UTF-8') <= $length) {
        return $string;
    }
    return mb_substr($string, 0, $length, 'UTF-8') . $dot;
}

function dhtmlspecialchars($string) {
    if (is_array($string)) {
        return array_map('dhtmlspecialchars', $string);
    }
    return htmlspecialchars((string)$string, ENT_QUOTES, 'UTF-8');
}

function alert($message, $url = '') {
    $message = addslashes((string)$message);
    $target = $url !== '' ? "location.href='" . addslashes($url) . "';" : 'history.back();';
    echo "<script>alert('{$message}');{$target}</script>";
    exit();
}

function msg($message, $url = '') {
    alert($message, $url);
}

function go($url) {
    header('Location: ' . $url);
    exit();
}

function getip() {
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        return trim($parts[0]);
    }
    return isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '127.0.0.1';
}

function get_upload_path($path = '') {
    $path = ltrim((string)$path, '/');
    return $path === '' ? 'upload/' : 'upload/' . $path;
}
?>
