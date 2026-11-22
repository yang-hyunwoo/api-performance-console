package spring_performance_test.repository;


import org.springframework.data.jpa.repository.JpaRepository;
import spring_performance_test.domain.TestRecord;

public interface TestRecordRepository extends JpaRepository<TestRecord, Long> {
}
