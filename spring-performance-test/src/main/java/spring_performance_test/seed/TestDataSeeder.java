package spring_performance_test.seed;

import java.sql.PreparedStatement;
import java.time.LocalDateTime;
import java.util.Random;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.BatchPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class TestDataSeeder {

    private static final int BATCH_SIZE = 1_000;

    private static final String[] CATEGORIES = {
            "CATEGORY_A",
            "CATEGORY_B",
            "CATEGORY_C",
            "CATEGORY_D",
            "CATEGORY_E"
    };

    private final JdbcTemplate jdbcTemplate;

    @Transactional
    public int seed(int count) {

        if (count < 1 || count > 1_000_000) {
            throw new IllegalArgumentException(
                    "count must be between 1 and 1000000"
            );
        }

        String sql = """
                INSERT INTO test_records
                (name, category, numeric_value, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """;

        Random random = new Random(42);

        for (int start = 0; start < count; start += BATCH_SIZE) {

            int batchStart = start;
            int currentBatchSize = Math.min(
                    BATCH_SIZE,
                    count - batchStart
            );

            jdbcTemplate.batchUpdate(
                    sql,
                    new BatchPreparedStatementSetter() {

                        @Override
                        public void setValues(
                                PreparedStatement ps,
                                int i
                        ) throws java.sql.SQLException {

                            int index = batchStart + i + 1;

                            LocalDateTime now = LocalDateTime.now();

                            ps.setString(
                                    1,
                                    "TEST_RECORD_" + index
                            );

                            ps.setString(
                                    2,
                                    CATEGORIES[random.nextInt(CATEGORIES.length)]
                            );

                            ps.setInt(
                                    3,
                                    random.nextInt(100_000)
                            );

                            ps.setBoolean(
                                    4,
                                    random.nextBoolean()
                            );

                            ps.setObject(5, now);
                            ps.setObject(6, now);
                        }

                        @Override
                        public int getBatchSize() {
                            return currentBatchSize;
                        }
                    }
            );
        }

        return count;
    }
}
