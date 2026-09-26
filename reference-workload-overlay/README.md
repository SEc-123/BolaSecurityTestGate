# 独立参考工作负载覆盖代码

这里的文件是针对独立、已授权的 Damn Vulnerable Bank 参考工作负载的本地兼容性覆盖，不属于 BSTG 产品逻辑，也不应复制到 BSTG 默认 profile。

覆盖内容包括：`MainActivity.java` 用于受控本地 CA 信任和真实业务 POST；`activity_banklogin.xml` 用于指向本地代理；Gradle 配置仅修复历史依赖仓库以可构建参考 APK；`bstg_local_mitm_ca.pem` 是本次隔离本地代理生成的公开 CA 证书。该覆盖不包含、也不实现证书锁定绕过、Frida、动态 hook 或面向第三方目标的逻辑。
