package spring_performance_test.domain;

import jakarta.persistence.*;
import java.time.LocalDateTime;

@Entity
@Table(name = "test_records")
public class TestRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 100)
    private String name;

    @Column(nullable = false, length = 50)
    private String category;

    @Column(name = "numeric_value", nullable = false)
    private Integer numericValue;

    @Column(nullable = false)
    private Boolean enabled;

    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;

    protected TestRecord() {
    }

    public TestRecord(
            String name,
            String category,
            Integer numericValue,
            Boolean enabled
    ) {
        this.name = name;
        this.category = category;
        this.numericValue = numericValue;
        this.enabled = enabled;
    }

    @PrePersist
    protected void onCreate() {
        LocalDateTime now = LocalDateTime.now();
        this.createdAt = now;
        this.updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        this.updatedAt = LocalDateTime.now();
    }

    public void update(
            String name,
            String category,
            Integer numericValue,
            Boolean enabled
    ) {
        this.name = name;
        this.category = category;
        this.numericValue = numericValue;
        this.enabled = enabled;
    }

    public Long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getCategory() {
        return category;
    }

    public Integer getNumericValue() {
        return numericValue;
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public LocalDateTime getUpdatedAt() {
        return updatedAt;
    }
}