package spring_performance_test.controller;

import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import spring_performance_test.seed.TestDataSeeder;

@RestController
@RequestMapping("/api/test-data")
@RequiredArgsConstructor
public class TestDataController {

    private final TestDataSeeder testDataSeeder;

    @PostMapping("/seed")
    public ResponseEntity<Map<String, Object>> seed(
            @RequestParam(defaultValue = "100000") int count
    ) {
        int inserted = testDataSeeder.seed(count);

        return ResponseEntity.ok(
                Map.of(
                        "inserted", inserted,
                        "message", "Test data created successfully"
                )
        );
    }
}