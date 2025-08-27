def calculate_average(grades):
    total = 0
    for g in grades:
        total += g
    return total / len(grades)  

def assign_letter_grade(score):
    if score > 90:      
        return "A"
    elif score > 80:  
        return "B"
    elif score > 70:   
        return "C"
    elif score > 60:   
        return "D"
    else:
        return "F"

def main():
    students = {
        "Alice": [95, 85, 100],
        "Bob": [70, 65, 60],
        "Charlie": []    
    }

    for student, grades in students.items():
        avg = calculate_average(grades)
        letter = assign_letter_grade(avg)
        print(student + " average: " + str(avg) + " grade: " + letter)

    print_student_summary(students)  

main()