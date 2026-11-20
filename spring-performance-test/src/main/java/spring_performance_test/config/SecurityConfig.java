package spring_performance_test.config;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.util.matcher.IpAddressMatcher;

@Configuration
public class SecurityConfig {

    private static final IpAddressMatcher LOCAL_IPV4 =
            new IpAddressMatcher("127.0.0.1");

    private static final IpAddressMatcher LOCAL_IPV6 =
            new IpAddressMatcher("::1");

    //TODO 내아이피만 수정
    private static final IpAddressMatcher OFFICE_IP =
            new IpAddressMatcher("203.0.113.10");

    private boolean isAllowedIp(HttpServletRequest request) {
        String ip = request.getRemoteAddr();

        return LOCAL_IPV4.matches(ip)
                || LOCAL_IPV6.matches(ip)
                || OFFICE_IP.matches(ip);
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http)
            throws Exception {

        http.authorizeHttpRequests(auth -> auth

                .requestMatchers(
                        "/v3/api-docs",
                        "/v3/api-docs/**",
                        "/swagger-ui/**",
                        "/swagger-ui.html"
                )
                .access((authentication, context) ->
                        new org.springframework.security.authorization.AuthorizationDecision(
                                isAllowedIp(context.getRequest())
                        )
                )

                .anyRequest().permitAll()
        );

        return http.build();
    }
}